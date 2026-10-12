// Worker steps (GitHub Actions runner with FFmpeg): fetch material, render,
// validate. Each step checkpoints its output so retries resume where they stopped.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StepError } from "../supabase/functions/_shared/core/backoff.ts";
import { alignToHeard, buildAss, type HeardWord, segmentRanges, timeWords } from "../supabase/functions/_shared/core/captions.ts";
import { illustrationPrompt } from "../supabase/functions/_shared/core/prompts.ts";
import { estimateBeforeCall } from "../supabase/functions/_shared/core/pricing.ts";
import { buildFfmpegArgs, planShots } from "../supabase/functions/_shared/core/render.ts";
import { MAX_VIDEO_SECONDS, MIN_VIDEO_SECONDS } from "../supabase/functions/_shared/core/script.ts";
import type { Job, Panel, Script } from "../supabase/functions/_shared/core/types.ts";
import { validateVideo } from "../supabase/functions/_shared/core/validation.ts";
import { connectorFor } from "../supabase/functions/_shared/connectors/index.ts";
import { linkPageRefs, NO_PAGES_MESSAGE } from "../supabase/functions/_shared/connectors/link.ts";
import type { PageRef } from "../supabase/functions/_shared/connectors/types.ts";
import { extOf, type UploadKind, uploadKind } from "../supabase/functions/_shared/core/uploads.ts";
import { analyze, type AudioOutput, type FetchOutput, writeScript } from "../supabase/functions/_shared/pipeline/edge_steps.ts";
import { claudeFirst } from "../supabase/functions/_shared/pipeline/llm.ts";
import { type Ctx, ensureAllowed, geminiFor, jobPath, trackGemini } from "../supabase/functions/_shared/pipeline/context.ts";
import type { StepHandler, StepOutcome } from "../supabase/functions/_shared/pipeline/runner.ts";
import { browserAvailable, browserPages } from "./browser.ts";
import { decodeErrors, ffprobe, imageSize, lumaStdDev, run, speechIntervals } from "./ffmpeg.ts";
import { expandUpload, naturalCompare, videoSubtitles } from "./files.ts";

const MAX_PANELS = 120;
const MAX_PAGES = 150;
const PANEL_WIDTH = 1080;

export const WORK_DIR = process.env.WORKER_TMP ?? join(tmpdir(), "autovideo-worker");
export const FONTS_DIR = process.env.FONTS_DIR ?? new URL("./fonts/", import.meta.url).pathname;
export const MUSIC_FILE = process.env.MUSIC_FILE ?? new URL("./assets/music.mp3", import.meta.url).pathname;

/** Runs fn over items with at most `size` in flight; results keep the input order. */
async function pool<T, R>(items: T[], size: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(lanes);
  return out;
}

/** Words heard in the narration, with times (worker/align.py); null when unavailable. */
export async function heardWords(audioFile: string): Promise<HeardWord[] | null> {
  if (process.env.CAPTION_ALIGN === "off") return null;
  const script = new URL("./align.py", import.meta.url).pathname;
  const r = await run(process.env.PYTHON ?? "python3", [script, audioFile, process.env.ALIGN_MODEL ?? "small"], { timeoutMs: 10 * 60_000 }).catch(() => null);
  if (!r || r.code !== 0) {
    console.log(`alinhamento indisponível: ${r ? r.stderr.slice(-300) : "python ausente"}`);
    return null;
  }
  try {
    const words = JSON.parse(r.stdout.toString()) as HeardWord[];
    return Array.isArray(words) && words.length > 0 ? words : null;
  } catch {
    return null;
  }
}

async function jobDir(job: Job): Promise<string> {
  const d = join(WORK_DIR, job.id);
  await mkdir(d, { recursive: true });
  return d;
}


// ------------------------------------------------------------------ fetching

/** Split one page into 9:16-friendly panels and drop blank slices. */
async function slicePage(src: string, outDir: string, page: number): Promise<{ file: string; id: string; width: number; height: number }[]> {
  const { width, height } = await imageSize(src);
  if (width < 300 || height < 200) return []; // icons, buttons, ads
  const w = Math.min(PANEL_WIDTH, width);
  const scaledH = Math.round((height * w) / width);
  const sliceH = Math.round(w * (16 / 9) * 1.15);
  const slices: { y: number; h: number }[] = [];
  if (scaledH <= sliceH * 1.35) {
    slices.push({ y: 0, h: scaledH });
  } else {
    const step = Math.round(sliceH * 0.9);
    for (let y = 0; y < scaledH; y += step) {
      const h = Math.min(sliceH, scaledH - y);
      if (h < sliceH * 0.35) break;
      slices.push({ y, h });
    }
  }
  const out: { file: string; id: string; width: number; height: number }[] = [];
  let k = 0;
  for (const s of slices) {
    const id = `p${String(page).padStart(3, "0")}-${++k}`;
    const file = join(outDir, `${id}.jpg`);
    const r = await run("ffmpeg", ["-v", "error", "-y", "-i", src, "-vf", `scale=${w}:-2,crop=${w}:${s.h}:0:${s.y}`, "-frames:v", "1", "-q:v", "3", file], { timeoutMs: 120_000 });
    if (r.code !== 0) throw new StepError(`Falha ao recortar página ${page}: ${r.stderr.slice(-300)}`, "permanent");
    if ((await lumaStdDev(file)) < 4) continue; // blank gutter / solid colour
    out.push({ file, id, width: w, height: s.h });
  }
  return out;
}

export async function fetchMaterial(ctx: Ctx, job: Job): Promise<StepOutcome> {
  const work = await ctx.repo.getWork(job.work_id);
  const chapter = job.chapter_id ? await ctx.repo.getChapter(job.chapter_id) : null;
  if (!work || !chapter) throw new StepError("Obra ou capítulo ausente", "permanent");
  const dir = join(await jobDir(job), "pages");
  await mkdir(dir, { recursive: true });

  // 1) material uploaded by the user for this chapter (images, PDFs, archives, text)
  const uploads = (await ctx.repo.objectsByPrefix(job.user_id, `uploads/${job.user_id}/${work.id}/${chapter.chapter_key}/`))
    .sort((a, b) => naturalCompare(a.path, b.path));
  await ctx.repo.attachObjectsToJob(uploads.map((u) => u.id), job.id);
  const sources: { name: string; kind: UploadKind; load: () => Promise<Uint8Array> }[] = [];
  const texts: FetchOutput["texts"] = [];
  for (const u of uploads) {
    const name = u.path.split("/").pop()!;
    const kind = uploadKind(u.content_type, name);
    if (kind === "text") texts.push({ path: u.path, name });
    else if (kind) sources.push({ name, kind, load: () => ctx.blobs.get(u.path) });
  }

  // 2) pages from the chapter link the user sent, or from the work's source
  if (sources.length === 0 && texts.length === 0) {
    const connector = connectorFor(work);
    let refs: PageRef[] = [];
    if (chapter.source_url && (work.source === "link" || work.source === "upload" || work.source === "manual" || !connector.pageRefs)) {
      try {
        refs = await linkPageRefs(chapter.source_url, ctx.fetch);
        console.log(`[fetching ${job.id}] ${refs.length} página(s) encontradas no HTML do link`);
      } catch (e) {
        if (!(e instanceof StepError) || e.message !== NO_PAGES_MESSAGE || !browserAvailable()) throw e;
        // the site draws the pages with JavaScript: open it in a real browser
        const pages = await browserPages(chapter.source_url);
        console.log(`[fetching ${job.id}] navegador: ${pages.length} página(s)`);
        if (pages.length < 2) throw e;
        for (const p of pages) sources.push({ name: p.name, kind: "image", load: async () => p.bytes });
      }
    } else if (connector.pageRefs) {
      refs = await connector.pageRefs(work, chapter, ctx.fetch);
    } else {
      throw new StepError("Este capítulo não tem link nem arquivos: envie o link ou os arquivos em Gerar vídeo", "waiting", 3 * 3600);
    }
    for (const ref of refs) {
      sources.push({
        name: ref.filename,
        kind: "image",
        load: async () => {
          const t0 = Date.now();
          let ok = false;
          let bytes = new Uint8Array();
          try {
            const res = await ctx.fetch(ref.url, { headers: ref.headers });
            if (!res.ok) throw new StepError(`Página indisponível (HTTP ${res.status})`, "retryable");
            bytes = new Uint8Array(await res.arrayBuffer());
            ok = true;
            return bytes;
          } finally {
            if (ref.reportTo) {
              await ctx.fetch(ref.reportTo, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ url: ref.url, success: ok, cached: false, bytes: bytes.length, duration: Date.now() - t0 }),
              }).catch(() => {});
            }
          }
        },
      });
    }
  }
  if (sources.length === 0 && texts.length === 0) throw new StepError("Nenhum material disponível para o capítulo", "permanent");

  // Download everything in parallel, then turn files into page images in order.
  const t0 = Date.now();
  const raws = await pool(sources, 6, async (src, i) => {
    const raw = join(dir, `src-${String(i).padStart(3, "0")}.${extOf(src.name) || "jpg"}`);
    await writeFile(raw, await src.load());
    return raw;
  });
  const pageFiles: string[] = [];
  for (let i = 0; i < sources.length && pageFiles.length < MAX_PAGES; i++) {
    pageFiles.push(...(await expandUpload(raws[i], sources[i].kind, join(dir, `x-${i}`), MAX_PAGES - pageFiles.length)));
    if (sources[i].kind === "video") {
      // the episode's own subtitles help the script (dialogue, names)
      const srt = await videoSubtitles(raws[i], join(dir, `sub-${i}`)).catch(() => null);
      if (srt) {
        const path = jobPath(job, `texts/legendas-${i + 1}.srt`);
        const bytes = await readFile(srt);
        await ctx.blobs.put(path, bytes, "application/x-subrip");
        await ctx.repo.registerObject(job.user_id, job.id, path, "upload", bytes.length, "application/x-subrip");
        texts.push({ path, name: `legendas do vídeo ${i + 1}.srt` });
      }
    }
  }
  const pageNo = Math.min(pageFiles.length, MAX_PAGES);
  console.log(`[fetching ${job.id}] ${sources.length} arquivo(s) → ${pageNo} página(s) em ${Math.round((Date.now() - t0) / 1000)}s`);

  // Slice pages into panels (parallel), keeping reading order.
  const sliced = await pool(pageFiles.slice(0, MAX_PAGES), 4, async (file, i) => {
    try {
      return await slicePage(file, dir, i + 1);
    } catch {
      return []; // unreadable image inside an archive: skip it
    }
  });
  const chosen = sliced.flatMap((slices, i) => slices.map((p) => ({ ...p, page: i + 1 }))).slice(0, MAX_PANELS);
  const panels: Panel[] = await pool(chosen, 6, async (p) => {
    const path = jobPath(job, `panels/${p.id}.jpg`);
    const bytes = await readFile(p.file);
    await ctx.blobs.put(path, bytes, "image/jpeg");
    await ctx.repo.registerObject(job.user_id, job.id, path, "image", bytes.length, "image/jpeg");
    // small copy for the AI analysis: faster requests, fewer tokens
    const small = join(dir, `${p.id}-thumb.jpg`);
    let thumb: string | undefined;
    const t = await run("ffmpeg", ["-v", "error", "-y", "-i", p.file, "-vf", "scale='min(512,iw)':-2", "-frames:v", "1", "-q:v", "5", small], { timeoutMs: 60_000 });
    if (t.code === 0) {
      thumb = jobPath(job, `thumbs/${p.id}.jpg`);
      const tb = await readFile(small);
      await ctx.blobs.put(thumb, tb, "image/jpeg");
      await ctx.repo.registerObject(job.user_id, job.id, thumb, "image", tb.length, "image/jpeg");
    }
    return { id: p.id, path, width: p.width, height: p.height, page: p.page, thumb };
  });
  console.log(`[fetching ${job.id}] ${panels.length} quadro(s) prontos em ${Math.round((Date.now() - t0) / 1000)}s`);
  if (panels.length === 0 && texts.length === 0) {
    throw new StepError("Não encontrei páginas legíveis nos arquivos enviados. Envie imagens, PDF, ZIP/CBZ ou vídeo.", "permanent");
  }
  await ctx.repo.updateChapter(chapter.id, { page_count: pageNo });
  const output: FetchOutput = { panels, texts };
  return { next: "analyzing", output };
}

// ------------------------------------------------------------------ rendering

async function illustrate(ctx: Ctx, job: Job, script: Script, existing: Panel[]): Promise<Panel[]> {
  const settings = await ctx.repo.getSettings(job.user_id);
  const work = await ctx.repo.getWork(job.work_id);
  const gemini = await geminiFor(ctx, job.user_id);
  const model = settings.gemini_image_model;
  const groups = Math.min(12, Math.max(4, Math.ceil(script.segments.length / 2)));
  const per = Math.ceil(script.segments.length / groups);
  const panels = [...existing];
  for (let g = 0; g < groups; g++) {
    const id = `ai-${String(g + 1).padStart(2, "0")}`;
    if (panels.some((p) => p.id === id)) continue; // checkpoint
    const text = script.segments.slice(g * per, (g + 1) * per).map((s) => s.text).join(" ");
    if (!text) continue;
    await ensureAllowed(ctx, job, "gemini_image", estimateBeforeCall("gemini_image", model, { images: 1, inputChars: text.length }, settings.gemini_tier, settings.price_overrides));
    const r = await gemini.generateImage(model, illustrationPrompt({ workTitle: work?.title ?? "", segmentText: text }));
    await trackGemini(ctx, job, settings, "gemini_image", model, r.usage, false, { images: 1, units: 1, unit_type: "images" });
    const path = jobPath(job, `panels/${id}.png`);
    await ctx.blobs.put(path, r.bytes, r.mimeType);
    await ctx.repo.registerObject(job.user_id, job.id, path, "image", r.bytes.length, r.mimeType);
    panels.push({ id, path, width: 1080, height: 1920 });
    await ctx.repo.saveStep(job.id, "rendering", "running", { illustrations: panels });
  }
  // map segments to their illustration
  script.segments.forEach((s, i) => {
    s.panels = [`ai-${String(Math.floor(i / per) + 1).padStart(2, "0")}`];
  });
  return panels;
}

export async function render(ctx: Ctx, job: Job): Promise<StepOutcome> {
  const started = Date.now();
  const settings = await ctx.repo.getSettings(job.user_id);
  const work = await ctx.repo.getWork(job.work_id);
  const scriptRow = await ctx.repo.getScript(job.id);
  const audio = (await ctx.repo.getStep(job.id, "audio_generating"))?.output as AudioOutput | undefined;
  if (!scriptRow || !audio?.path) throw new StepError("Roteiro ou narração ausente", "permanent");
  const fetched = (await ctx.repo.getStep(job.id, "fetching"))?.output as FetchOutput | undefined;
  const prevRender = (await ctx.repo.getStep(job.id, "rendering"))?.output as { illustrations?: Panel[] } | undefined;
  const script: Script = {
    title: scriptRow.title, description: scriptRow.description, hashtags: scriptRow.hashtags, hook: "",
    segments: structuredClone(scriptRow.segments as Script["segments"]),
  };

  await ensureAllowed(ctx, job, "render", 0);
  let panels = fetched?.panels ?? [];
  if (work?.visual_mode === "ai_illustrations" || panels.length === 0) {
    panels = await illustrate(ctx, job, script, prevRender?.illustrations ?? []);
  }
  if (panels.length === 0) throw new StepError("Sem imagens para o vídeo", "permanent");

  const dir = await jobDir(job);
  const imgDir = join(dir, "render");
  await mkdir(imgDir, { recursive: true });
  const used = new Set(script.segments.flatMap((s) => s.panels));
  const images: Record<string, string> = {};
  for (const p of panels) {
    if (used.size && !used.has(p.id) && Object.keys(images).length > 0) continue;
    const file = join(imgDir, `${p.id}${p.path.endsWith(".png") ? ".png" : ".jpg"}`);
    if (!existsSync(file)) await writeFile(file, await ctx.blobs.get(p.path));
    images[p.id] = file;
  }
  const usablePanels = panels.filter((p) => images[p.id]);
  const audioFile = join(dir, "narration.wav");
  if (!existsSync(audioFile)) await writeFile(audioFile, await ctx.blobs.get(audio.path));

  // Caption timing follows the real narration (after tempo adjustment).
  const tempo = audio.tempo || 1;
  const narrSeconds = audio.duration / tempo;
  const speech = (await speechIntervals(audioFile, audio.duration)).map((s) => ({ start: s.start / tempo, end: s.end / tempo }));
  const D = Math.min(MAX_VIDEO_SECONDS + 0.5, Math.max(audio.video_seconds, Math.min(narrSeconds, MAX_VIDEO_SECONDS)));
  // Real word timings from speech recognition of the narration; the estimate
  // (proportional to word length, inside the detected speech) is the fallback.
  const heard = await heardWords(audioFile);
  const aligned = heard ? alignToHeard(script.segments, heard, tempo) : null;
  const words = aligned ?? timeWords(script.segments, narrSeconds, speech);
  console.log(`[rendering ${job.id}] legendas: ${aligned ? `sincronizadas pela fala (${heard!.length} palavras ouvidas)` : "tempo estimado"}`);
  const ranges = segmentRanges(words, script.segments.length, D);
  const shots = planShots(script.segments, ranges, usablePanels, D);
  const assFile = join(dir, "captions.ass");
  await writeFile(assFile, buildAss(words, settings.caption_style));
  const out = join(dir, "video.mp4");
  const music = settings.background_music && existsSync(MUSIC_FILE) ? MUSIC_FILE : undefined;
  const args = buildFfmpegArgs({
    shots, images, audioPath: audioFile, assPath: assFile, fontsDir: existsSync(FONTS_DIR) ? FONTS_DIR : undefined,
    musicPath: music, tempo, duration: D, outputPath: out,
  });
  const r = await run("ffmpeg", args, { timeoutMs: 45 * 60_000 });
  if (r.code !== 0 || !existsSync(out)) {
    throw new StepError(`FFmpeg falhou (código ${r.code}): ${r.stderr.slice(-800)}`, "retryable");
  }
  const bytes = await readFile(out);
  const path = jobPath(job, "video.mp4");
  await ctx.blobs.put(path, bytes, "video/mp4");
  // Registered as "partial" until validation accepts it.
  const obj = await ctx.repo.registerObject(job.user_id, job.id, path, "partial", bytes.length, "video/mp4", false);
  const renderSeconds = Math.round((Date.now() - started) / 1000);
  await ctx.repo.recordUsage({ user_id: job.user_id, job_id: job.id, provider: "github", kind: "render", model: "ffmpeg", units: renderSeconds, unit_type: "runner_seconds", cost_usd: 0 });
  return {
    next: "validating",
    output: {
      path, object_id: obj.id, duration: D, shots: shots.length, caption_events: words.length,
      render_seconds: renderSeconds, illustrations: prevRender?.illustrations ?? (work?.visual_mode === "ai_illustrations" ? panels : undefined),
    },
  };
}

// ------------------------------------------------------------------ validating

export async function validate(ctx: Ctx, job: Job): Promise<StepOutcome> {
  const rendered = (await ctx.repo.getStep(job.id, "rendering"))?.output as { path: string; object_id: string; duration: number; caption_events: number } | undefined;
  if (!rendered?.path) throw new StepError("Renderização ausente", "permanent");
  const dir = await jobDir(job);
  const file = join(dir, "video.mp4");
  if (!existsSync(file)) await writeFile(file, await ctx.blobs.get(rendered.path));

  const probe = await ffprobe(file);
  const report = validateVideo({
    probe,
    decodeErrors: await decodeErrors(file),
    expectedDuration: rendered.duration,
    minSeconds: MIN_VIDEO_SECONDS,
    maxSeconds: MAX_VIDEO_SECONDS,
    captionEvents: rendered.caption_events,
    captionsRequired: true,
  });
  const prev = (await ctx.repo.getStep(job.id, "validating"))?.output as { failures?: number } | undefined;
  if (!report.ok) {
    const failures = (prev?.failures ?? 0) + 1;
    const failed = report.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join("; ");
    if (failures >= 2) throw new StepError(`Vídeo reprovado na validação: ${failed}`, "permanent");
    await rm(file, { force: true });
    return { next: "rendering", output: { failures, report } };
  }

  const script = await ctx.repo.getScript(job.id);
  const obj = await ctx.repo.registerObject(job.user_id, job.id, rendered.path, "video", report.sizeBytes, "video/mp4", true);
  const now = ctx.now().toISOString();
  await ctx.repo.saveVideo({
    user_id: job.user_id, job_id: job.id, work_id: job.work_id, title: script?.title ?? "Resumo",
    duration_seconds: report.duration, width: report.width, height: report.height, size_bytes: report.sizeBytes,
    render_provider: "ffmpeg", validation: report, storage_object_id: obj.id, rendered_at: now, validated_at: now,
  });
  if (job.chapter_id) {
    const chapter = await ctx.repo.getChapter(job.chapter_id);
    await ctx.repo.updateChapter(job.chapter_id, { status: "processed", processed_at: now });
    if (chapter) await ctx.repo.updateWork(job.work_id, { last_processed_chapter: chapter.chapter_key });
  }
  await rm(dir, { recursive: true, force: true });
  return { next: "ready_to_publish", output: { report, object_id: obj.id } };
}

function timed(name: string, fn: StepHandler): StepHandler {
  return async (ctx, job) => {
    const t0 = Date.now();
    console.log(`[${name} ${job.id}] início`);
    try {
      const r = await fn(ctx, job);
      console.log(`[${name} ${job.id}] ok em ${Math.round((Date.now() - t0) / 1000)}s`);
      return r;
    } catch (e) {
      console.log(`[${name} ${job.id}] erro em ${Math.round((Date.now() - t0) / 1000)}s: ${(e as Error).message.slice(0, 300)}`);
      throw e;
    }
  };
}

/** Analysis and script run here only for users who put Claude first. */
function claudeStep(step: StepHandler): StepHandler {
  return async (ctx, job) => {
    const settings = await ctx.repo.getSettings(job.user_id);
    if (!claudeFirst(settings)) return { handoff: true };
    return step(ctx, job);
  };
}

export const WORKER_HANDLERS: Record<string, StepHandler> = {
  fetching: timed("fetching", fetchMaterial),
  analyzing: timed("analyzing", claudeStep(analyze)),
  scripting: timed("scripting", claudeStep(writeScript)),
  rendering: timed("rendering", render),
  validating: timed("validating", validate),
};
