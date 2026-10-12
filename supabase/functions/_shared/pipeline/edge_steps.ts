// Steps executed inside Edge Functions: short, network-bound and resumable.

import { StepError } from "../core/backoff.ts";
import { isTimeout } from "../adapters/http.ts";
import { type MemoryUpdate, memoryContext, mergeMemory } from "../core/memory.ts";
import { estimateBeforeCall } from "../core/pricing.ts";
import {
  ANALYSIS_SCHEMA, analysisPrompt, REVIEW_SCHEMA, reviewPrompt, SCRIPT_SCHEMA, scriptPrompt, textAnalysisPrompt,
} from "../core/prompts.ts";
import { contentKey } from "../core/schedule.ts";
import {
  countWords, fillMissingPanels, fitDuration, MAX_VIDEO_SECONDS, MIN_VIDEO_SECONDS, normalizeScript, scriptText,
  targetWords, validateScript,
} from "../core/script.ts";
import type { Chapter, Job, Panel, Script, UserSettings, Work } from "../core/types.ts";
import { imagePart, inferCapabilities, type Part } from "../adapters/gemini.ts";
import { connectorFor } from "../connectors/index.ts";
import {
  type Ctx, ensureAllowed, geminiFor, jobPath, remainingMs, trackGemini,
} from "./context.ts";
import { generateJsonAny, ImageLimitError } from "./llm.ts";
import type { StepOutcome } from "./runner.ts";

// ------------------------------------------------------------------ shared types

export interface FetchOutput {
  panels: Panel[];
  texts: { path: string; name: string }[];
}

interface PanelAnalysis {
  id: string;
  scene: string;
  characters?: string[];
  dialogues: { speaker: string; text: string; meaning: string }[];
  usable: boolean;
}

interface AnalysisBatch {
  panels: PanelAnalysis[];
  events: { description: string; certainty: string; panels: string[] }[];
  batch_summary: string;
}

interface AnalysisState {
  next: number;
  batches: AnalysisBatch[];
  textDone?: boolean;
  /** images per call; halves when Gemini takes too long */
  size?: number;
}

export interface ChapterAnalysis {
  panels: PanelAnalysis[];
  events: AnalysisBatch["events"];
  summaries: string[];
}

const BATCH = 12;
/** At most this many images are analysed per chapter (evenly spread). */
const MAX_ANALYSED = 60;

/** Panel image for the AI; when the cleanup removed it, the pages are fetched again. */
async function panelBytes(ctx: Ctx, p: Panel): Promise<Uint8Array> {
  try {
    return await ctx.blobs.get(p.thumb ?? p.path);
  } catch (e) {
    if (!/not found|não encontrad/i.test((e as Error).message)) throw e;
    // the retry resumes from "fetching" (see resume_point in the database)
    throw new StepError("As imagens deste capítulo expiraram no servidor; elas serão buscadas de novo na próxima tentativa.", "retryable", 30);
  }
}

export function sampleEvenly<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  return Array.from({ length: max }, (_, i) => items[Math.floor((i * items.length) / max)]);
}

async function load(ctx: Ctx, job: Job): Promise<{ work: Work; settings: UserSettings; chapter: Chapter | null }> {
  const work = await ctx.repo.getWork(job.work_id);
  if (!work) throw new StepError("Obra removida", "permanent");
  const settings = await ctx.repo.getSettings(job.user_id);
  const chapter = job.chapter_id ? await ctx.repo.getChapter(job.chapter_id) : null;
  return { work, settings, chapter };
}

function chapterLabel(c: Chapter | null, job: Job): string {
  if (!c) return job.summary_format === "recap" ? "recapitulação" : "visão geral";
  return c.number !== null ? `capítulo ${c.number}${c.title ? ` — ${c.title}` : ""}` : c.title ?? `capítulo ${c.chapter_key}`;
}

const MEMORY_FORMATS = new Set(["recap", "arc", "full_work"]);

// ------------------------------------------------------------------ discovering

export async function discover(ctx: Ctx, job: Job): Promise<StepOutcome> {
  const { work } = await load(ctx, job);
  if (work.status === "paused") throw new StepError("Obra pausada", "waiting", 6 * 3600);

  if (MEMORY_FORMATS.has(job.summary_format)) return discoverMemoryBased(ctx, job, work);

  if (job.chapter_id) return { next: "fetching" }; // checkpoint: chapter already chosen

  const connector = connectorFor(work);
  if (connector.detectsChapters) {
    // Refresh the chapter list if the monitor has not done it recently.
    try {
      const chapters = await connector.listChapters(work, ctx.fetch);
      const added = await ctx.repo.upsertChapters(work.user_id, work.id, chapters);
      if (added > 0) await ctx.repo.log({ user_id: job.user_id, job_id: job.id, level: "info", event: "chapters_found", message: `${added} capítulo(s) novo(s)` });
    } catch (e) {
      await ctx.repo.log({ user_id: job.user_id, job_id: job.id, level: "warn", event: "source_error", message: (e as Error).message });
    }
  }

  const chapter = await ctx.repo.nextChapter(work.id, job.summary_format);
  if (!chapter) return noChapter(ctx, job, work);

  try {
    await ctx.repo.updateJob(job.id, { chapter_id: chapter.id, content_key: contentKey(work.id, chapter.chapter_key, job.summary_format) });
  } catch {
    // Another job took this chapter at the same time (unique content_key).
    throw new StepError("Capítulo já em produção por outra tarefa", "retryable", 60);
  }
  await ctx.repo.updateChapter(chapter.id, { status: "processing" });
  return { next: "fetching", output: { chapter_id: chapter.id, chapter_key: chapter.chapter_key } };
}

async function noChapter(ctx: Ctx, job: Job, work: Work): Promise<StepOutcome> {
  const schedules = await ctx.repo.activeSchedules();
  const schedule = schedules.find((s) => s.id === job.schedule_id);
  const policy = schedule?.no_chapter_policy ?? "wait";
  const overdue = ctx.now().getTime() > new Date(job.slot_at).getTime() + 24 * 3600_000;
  if (policy === "skip" || (policy === "wait" && overdue)) {
    throw new StepError(
      overdue ? "Nenhum capítulo novo até 24 h após o horário programado; tarefa encerrada sem inventar conteúdo" : "Sem capítulo novo; programação configurada para pular",
      "permanent",
    );
  }
  if (policy === "replace" && schedule) {
    if (work.visual_mode !== "ai_illustrations") {
      throw new StepError("Sem capítulo novo. A substituição por recapitulação exige o modo visual 'ilustrações originais'", "waiting", Math.min(work.monitor_interval_minutes, 120) * 60);
    }
    const day = job.slot_at.slice(0, 10);
    await ctx.repo.updateJob(job.id, { summary_format: schedule.replacement_format, content_key: contentKey(work.id, `recap-${day}`, schedule.replacement_format) });
    await ctx.repo.log({ user_id: job.user_id, job_id: job.id, level: "info", event: "replaced", message: `Sem capítulo novo: substituída por ${schedule.replacement_format}` });
    return { next: "scripting", output: { replaced: schedule.replacement_format } };
  }
  throw new StepError("Aguardando capítulo novo — nenhum acontecimento será inventado", "waiting", Math.min(work.monitor_interval_minutes, 120) * 60);
}

async function discoverMemoryBased(ctx: Ctx, job: Job, work: Work): Promise<StepOutcome> {
  if (work.visual_mode !== "ai_illustrations") {
    throw new StepError("Resumos de arco/obra/recapitulação usam a memória narrativa e exigem o modo visual 'ilustrações originais'", "config");
  }
  const memory = await ctx.repo.getMemory(work.id);
  if (memory.length === 0) throw new StepError("Memória narrativa vazia: processe ao menos um capítulo antes", "waiting", 6 * 3600);
  const latest = (await ctx.repo.processedChapters(work.id, 1))[0];
  if (!job.content_key) {
    await ctx.repo.updateJob(job.id, { content_key: contentKey(work.id, `${job.summary_format}-until-${latest?.chapter_key ?? "0"}`, job.summary_format) });
  }
  return { next: "scripting" };
}

// ------------------------------------------------------------------ analyzing

export async function analyze(ctx: Ctx, job: Job): Promise<StepOutcome> {
  const { work, settings, chapter } = await load(ctx, job);
  const fetched = (await ctx.repo.getStep(job.id, "fetching"))?.output as FetchOutput | undefined;
  if (!fetched) throw new StepError("Material do capítulo ausente (etapa de obtenção não concluída)", "permanent");
  const prev = (await ctx.repo.getStep(job.id, "analyzing"))?.output as AnalysisState | undefined;
  const state: AnalysisState = prev?.batches ? prev : { next: 0, batches: [] };
  const model = settings.gemini_text_model;
  const memory = memoryContext(await ctx.repo.getMemory(work.id), 6000);
  const label = chapterLabel(chapter, job);

  // Text material (subtitles / scripts) is analysed in a single call.
  if (fetched.texts.length > 0 && !state.textDone) {
    const texts: string[] = [];
    for (const t of fetched.texts) texts.push(`### ${t.name}\n${new TextDecoder().decode(await ctx.blobs.get(t.path)).slice(0, 60_000)}`);
    const body = texts.join("\n\n").slice(0, 120_000);
    await ensureAllowed(ctx, job, "gemini_text", estimateBeforeCall("gemini_text", model, { inputChars: body.length }, settings.gemini_tier, settings.price_overrides));
    const r = await generateJsonAny<AnalysisBatch>(ctx, job, settings, [
      { text: textAnalysisPrompt({ workTitle: work.title, workType: work.type, chapterLabel: label, memory }) },
      { text: body },
    ], ANALYSIS_SCHEMA, { timeoutMs: Math.min(110_000, remainingMs(ctx) - 5_000) });
    state.batches.push({ panels: [], events: r.data.events ?? [], batch_summary: r.data.batch_summary ?? "" });
    state.textDone = true;
    await ctx.repo.saveStep(job.id, "analyzing", "running", state);
  }

  const panels = sampleEvenly(fetched.panels, MAX_ANALYSED);
  while (state.next < panels.length) {
    if (remainingMs(ctx) < 85_000) {
      return { stay: true, output: state, reason: `Análise parcial: ${state.next}/${panels.length} imagens` };
    }
    const size = state.size ?? BATCH;
    const batch = panels.slice(state.next, state.next + size);
    const parts: Part[] = [{
      text: analysisPrompt({
        workTitle: work.title,
        workType: work.type,
        chapterLabel: label,
        memory,
        previousSummary: state.batches.map((b) => b.batch_summary).join(" ").slice(-3000),
        panelIds: batch.map((p) => p.id),
      }),
    }];
    for (const p of batch) {
      parts.push({ text: `Painel ${p.id}:` });
      parts.push(imagePart(await panelBytes(ctx, p), "image/jpeg"));
    }
    await ensureAllowed(ctx, job, "gemini_text", estimateBeforeCall("gemini_text", model, { images: batch.length, inputChars: 4000 }, settings.gemini_tier, settings.price_overrides));
    let r;
    try {
      r = await generateJsonAny<AnalysisBatch>(ctx, job, settings, parts, ANALYSIS_SCHEMA, { timeoutMs: Math.min(110_000, remainingMs(ctx) - 5_000), quick: true });
    } catch (e) {
      if (e instanceof ImageLimitError) {
        // the AI that can answer now takes fewer images per request
        state.size = e.max;
        continue;
      }
      if (!isTimeout(e) || size <= 1) throw e;
      // the AI took too long for this many images: try again soon with fewer
      state.size = Math.max(1, Math.floor(size / 2));
      return { stay: true, delaySeconds: 5, output: state, reason: `A IA demorou; analisando ${state.size} imagem(ns) por vez` };
    }
    const known = new Set(batch.map((p) => p.id));
    state.batches.push({
      panels: (r.data.panels ?? []).filter((p) => known.has(p.id)),
      events: r.data.events ?? [],
      batch_summary: r.data.batch_summary ?? "",
    });
    state.next += batch.length;
    // Checkpoint after every batch: a failure never repeats finished batches.
    await ctx.repo.saveStep(job.id, "analyzing", "running", state);
  }

  const analysis: ChapterAnalysis = {
    panels: state.batches.flatMap((b) => b.panels),
    events: state.batches.flatMap((b) => b.events),
    summaries: state.batches.map((b) => b.batch_summary),
  };
  if (analysis.events.length === 0 && analysis.panels.every((p) => !p.usable)) {
    throw new StepError("Nenhum acontecimento identificado no material", "permanent");
  }
  if (chapter) await ctx.repo.updateChapter(chapter.id, { analysis });
  return { next: "scripting", output: { ...state, done: true } };
}

export function analysisText(a: ChapterAnalysis): string {
  const lines: string[] = ["Acontecimentos:"];
  a.events.forEach((e, i) => lines.push(`${i + 1}. [${e.certainty === "confirmed" ? "FATO" : "INTERPRETAÇÃO"}] ${e.description} (imagens: ${e.panels.join(", ") || "-"})`));
  lines.push("", "Imagens (na ordem):");
  for (const p of a.panels.filter((x) => x.usable)) {
    const falas = p.dialogues.map((d) => `${d.speaker}: ${d.meaning}`).join(" / ");
    lines.push(`- ${p.id}: ${p.scene}${falas ? ` | falas (sentido): ${falas}` : ""}`);
  }
  return lines.join("\n").slice(0, 60_000);
}

// ------------------------------------------------------------------ scripting

interface ScriptAI extends Script {
  key_points?: { conflicts?: string[]; revelations?: string[]; consequences?: string[] };
  chapter_summary?: string;
  memory_updates?: MemoryUpdate[];
}

export async function writeScript(ctx: Ctx, job: Job): Promise<StepOutcome> {
  const { work, settings, chapter } = await load(ctx, job);
  const audioStep = (await ctx.repo.getStep(job.id, "audio_generating"))?.output as { rewrite?: { targetWords: number; reason: string } } | undefined;
  const existing = await ctx.repo.getScript(job.id);
  if (existing && !audioStep?.rewrite) return { next: "audio_generating", output: { script_id: existing.id, reused: true } };

  const fetched = (await ctx.repo.getStep(job.id, "fetching"))?.output as FetchOutput | undefined;
  const panels = fetched?.panels ?? [];
  const analysis = chapter?.analysis as unknown as ChapterAnalysis | undefined;
  const usable = analysis ? new Set(analysis.panels.filter((p) => p.usable).map((p) => p.id)) : null;
  const usablePanels = panels.filter((p) => !usable || usable.has(p.id));
  const memoryEntries = await ctx.repo.getMemory(work.id);
  const memory = memoryContext(memoryEntries);

  let analysisBlock: string;
  if (analysis) {
    analysisBlock = analysisText(analysis);
  } else {
    // Memory-based formats: only previously confirmed material is used.
    const done = await ctx.repo.processedChapters(work.id, 30);
    analysisBlock = ["Resumos de capítulos já processados:", ...done.reverse().map((c) => `- ${chapterLabel(c, job)}: ${c.summary ?? ""}`)].join("\n");
  }

  const model = settings.gemini_text_model;
  const target = job.target_duration_seconds;
  const words = audioStep?.rewrite?.targetWords ?? targetWords(target);
  const feedback: string[] = audioStep?.rewrite ? [`${audioStep.rewrite.reason}. Ajuste para cerca de ${words} palavras.`] : [];
  const dialogues = analysis?.panels.flatMap((p) => p.dialogues.map((d) => d.text)) ?? [];

  let script: Script | null = null;
  let ai: ScriptAI | null = null;
  type Review = { consistent: boolean; issues: { severity: string; problem: string; fix?: string }[] };
  let review: Review | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (remainingMs(ctx) < 35_000) throw new StepError("Tempo da função esgotado durante o roteiro", "retryable", 30);
    const prompt = scriptPrompt({
      workTitle: work.title,
      workType: work.type,
      format: job.summary_format,
      chapterLabel: chapterLabel(chapter, job),
      targetSeconds: target,
      targetWords: words,
      memory,
      analysis: analysisBlock,
      panelIds: usablePanels.map((p) => p.id),
      feedback,
    });
    await ensureAllowed(ctx, job, "gemini_text", estimateBeforeCall("gemini_text", model, { inputChars: prompt.length }, settings.gemini_tier, settings.price_overrides));
    const r = await generateJsonAny<ScriptAI>(ctx, job, settings, [{ text: prompt }], SCRIPT_SCHEMA, { timeoutMs: Math.min(90_000, remainingMs(ctx) - 5_000) });
    ai = r.data;
    script = normalizeScript(r.data, usablePanels);
    const issues = validateScript(script, { targetSeconds: target, sourceDialogues: dialogues, requirePanels: usablePanels.length > 0 });
    const errors = issues.filter((i) => i.level === "error");
    if (errors.length > 0) {
      feedback.splice(0, feedback.length, ...errors.map((e) => e.message));
      script = null;
      continue;
    }
    // Coherence and continuity review against the analysis and memory.
    if (remainingMs(ctx) < 30_000) throw new StepError("Tempo da função esgotado antes da revisão", "retryable", 30);
    const rp = reviewPrompt({ script: scriptText(script), analysis: analysisBlock, memory });
    await ensureAllowed(ctx, job, "gemini_text", estimateBeforeCall("gemini_text", model, { inputChars: rp.length, outputTokens: 2000 }, settings.gemini_tier, settings.price_overrides));
    const rv = await generateJsonAny<Review>(ctx, job, settings, [{ text: rp }], REVIEW_SCHEMA, { timeoutMs: Math.min(60_000, remainingMs(ctx) - 5_000) });
    const current: Review = rv.data;
    review = current;
    const high = (current.issues ?? []).filter((i) => i.severity === "high");
    if (high.length === 0) break;
    feedback.splice(0, feedback.length, ...high.map((i) => `${i.problem}${i.fix ? ` → ${i.fix}` : ""}`));
    script = null;
  }
  if (!script || !ai) {
    throw new StepError(`Roteiro reprovado na validação: ${feedback.slice(0, 3).join("; ")}`, "permanent");
  }
  const descriptions = Object.fromEntries((analysis?.panels ?? []).map((p) => [
    p.id, [p.scene, ...(p.characters ?? []), ...p.dialogues.map((d) => `${d.speaker} ${d.meaning}`)].join(" "),
  ]));
  script = fillMissingPanels(script, usablePanels, descriptions);

  const scriptId = await ctx.repo.saveScript({
    user_id: job.user_id,
    job_id: job.id,
    work_id: work.id,
    chapter_id: chapter?.id ?? null,
    title: script.title,
    description: script.description,
    hashtags: script.hashtags,
    segments: script.segments,
    full_text: scriptText(script),
    word_count: countWords(scriptText(script)),
    model,
    validation: { review, key_points: ai.key_points ?? null, hook: script.hook },
  });

  // Update the narrative memory (facts, interpretations, theories).
  const merged = mergeMemory(memoryEntries, ai.memory_updates ?? [], chapter?.chapter_key ?? "memória");
  await ctx.repo.upsertMemory(job.user_id, work.id, merged.upserts);
  if (chapter && ai.chapter_summary) await ctx.repo.updateChapter(chapter.id, { summary: ai.chapter_summary.slice(0, 4000) });
  if (audioStep?.rewrite) await ctx.repo.saveStep(job.id, "audio_generating", "running", { rewritten: true, rewrite: null });
  return {
    next: "audio_generating",
    output: { script_id: scriptId, memory_added: merged.upserts.length, memory_rejected: merged.rejected.length },
  };
}

// ------------------------------------------------------------------ audio

export interface AudioOutput {
  path: string;
  object_id: string;
  duration: number;
  video_seconds: number;
  tempo: number;
  pad_seconds: number;
  rewrites: number;
}

export async function generateAudio(ctx: Ctx, job: Job): Promise<StepOutcome> {
  const { settings } = await load(ctx, job);
  const script = await ctx.repo.getScript(job.id);
  if (!script) throw new StepError("Roteiro ausente", "permanent");
  const prev = (await ctx.repo.getStep(job.id, "audio_generating"))?.output as (Partial<AudioOutput> & { rewritten?: boolean }) | undefined;
  if (prev?.path && prev.object_id && (await ctx.repo.objectsForJob(job.id, ["audio"])).some((o) => o.id === prev.object_id)) {
    return { next: "rendering", output: prev };
  }

  const model = settings.gemini_tts_model;
  if (!inferCapabilities({ name: model, supportedGenerationMethods: ["generateContent"] }).includes("tts")) {
    throw new StepError(`O modelo "${model}" não é um modelo de fala (TTS). Escolha um modelo TTS em Configurações`, "config");
  }
  const segments = script.segments as Script["segments"];
  const text = segments.map((s) => s.text).join("\n\n");
  await ensureAllowed(ctx, job, "gemini_tts", estimateBeforeCall("gemini_tts", model, { inputChars: text.length, audioSeconds: job.target_duration_seconds * 1.3 }, settings.gemini_tier, settings.price_overrides));
  const gemini = await geminiFor(ctx, job.user_id);
  const r = await gemini.synthesize(model, text, {
    voice: settings.gemini_voice,
    languageCode: "pt-BR",
    timeoutMs: Math.max(30_000, remainingMs(ctx) - 8_000),
  });
  await trackGemini(ctx, job, settings, "gemini_tts", model, r.usage, false, { units: r.durationSeconds, unit_type: "audio_seconds" });

  const words = countWords(text);
  const rewrites = prev?.rewritten ? 1 : 0;
  const decision = fitDuration(r.durationSeconds, job.target_duration_seconds, words, rewrites === 0);
  if (decision.action === "rewrite") {
    if (rewrites === 0) {
      await ctx.repo.saveStep(job.id, "audio_generating", "running", { rewrite: { targetWords: decision.targetWords, reason: decision.reason } });
      return { next: "scripting", output: { rewrite: { targetWords: decision.targetWords, reason: decision.reason } } };
    }
    if (r.durationSeconds < MIN_VIDEO_SECONDS - 4 || r.durationSeconds > MAX_VIDEO_SECONDS * 1.08) {
      throw new StepError(`Narração com ${r.durationSeconds.toFixed(1)} s fora dos limites de 1–3 min mesmo após reescrita`, "permanent");
    }
  }
  const tempo = decision.action === "tempo" ? decision.tempo : 1;
  const pad = decision.action === "pad" ? decision.padSeconds : 0;
  const videoSeconds = decision.action === "rewrite"
    ? Math.min(MAX_VIDEO_SECONDS, Math.max(MIN_VIDEO_SECONDS, r.durationSeconds))
    : decision.videoSeconds;

  const path = jobPath(job, "narration.wav");
  await ctx.blobs.put(path, r.wav, "audio/wav");
  const obj = await ctx.repo.registerObject(job.user_id, job.id, path, "audio", r.wav.length, "audio/wav");
  await ctx.repo.saveNarration({
    user_id: job.user_id, job_id: job.id, script_id: script.id, model, voice: settings.gemini_voice,
    duration_seconds: r.durationSeconds, storage_object_id: obj.id,
  });
  const output: AudioOutput = { path, object_id: obj.id, duration: r.durationSeconds, video_seconds: videoSeconds, tempo, pad_seconds: pad, rewrites };
  await ctx.repo.updateJob(job.id, { render_requested_at: ctx.now().toISOString() });
  return { next: "rendering", output };
}

export { jobPath };
