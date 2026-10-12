// Deterministic checks of AI-written scripts and duration control.

import type { Panel, Script, ScriptSegment } from "./types.ts";

export const MIN_VIDEO_SECONDS = 60;
export const MAX_VIDEO_SECONDS = 180;
/** Typical pace of pt-BR TTS narration; recalibrated from the real audio. */
export const DEFAULT_WORDS_PER_SECOND = 2.6;

export function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

export function scriptText(s: Pick<Script, "segments">): string {
  return s.segments.map((x) => x.text.trim()).join(" ");
}

export function targetWords(targetSeconds: number, wps = DEFAULT_WORDS_PER_SECOND): number {
  return Math.round(targetSeconds * wps);
}

export interface DurationBounds {
  min: number;
  max: number;
}

/** Bounds for a target: ±20 % of the target, always inside 60–180 s. */
export function boundsFor(targetSeconds: number): DurationBounds {
  return {
    min: Math.max(MIN_VIDEO_SECONDS, Math.round(targetSeconds * 0.8)),
    max: Math.min(MAX_VIDEO_SECONDS, Math.round(targetSeconds * 1.2)),
  };
}

export type DurationDecision =
  | { action: "ok"; videoSeconds: number }
  | { action: "tempo"; tempo: number; videoSeconds: number }
  | { action: "pad"; padSeconds: number; videoSeconds: number }
  | { action: "rewrite"; targetWords: number; reason: string };

/**
 * The video length follows the real narration. Small deviations are fixed
 * without new AI calls (speed ±8 %, or a short closing card); large ones
 * require rewriting the script once with the measured speaking pace.
 */
export function fitDuration(
  audioSeconds: number,
  targetSeconds: number,
  words: number,
  allowRewrite: boolean,
): DurationDecision {
  const b = boundsFor(targetSeconds);
  if (audioSeconds >= b.min && audioSeconds <= b.max) return { action: "ok", videoSeconds: audioSeconds };
  const wps = words > 0 && audioSeconds > 0 ? words / audioSeconds : DEFAULT_WORDS_PER_SECOND;
  if (audioSeconds > b.max) {
    const tempo = audioSeconds / b.max;
    if (tempo <= 1.08) return { action: "tempo", tempo, videoSeconds: b.max };
    if (!allowRewrite && audioSeconds / MAX_VIDEO_SECONDS <= 1.08) {
      const t = Math.max(1, audioSeconds / MAX_VIDEO_SECONDS);
      return { action: "tempo", tempo: t, videoSeconds: audioSeconds / t };
    }
  } else {
    const missing = b.min - audioSeconds;
    if (missing <= 4) return { action: "pad", padSeconds: missing, videoSeconds: b.min };
    if (!allowRewrite && audioSeconds >= MIN_VIDEO_SECONDS) return { action: "ok", videoSeconds: audioSeconds };
  }
  return {
    action: "rewrite",
    targetWords: Math.round(targetSeconds * wps),
    reason: `Narração com ${audioSeconds.toFixed(1)} s fora do intervalo ${b.min}–${b.max} s`,
  };
}

// ------------------------------------------------------------------ copy detection

function normTokens(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * Sequences of `n` consecutive words of the script that also appear in the
 * source dialogues. Used to block mechanical copying of the original text.
 */
export function copiedPassages(script: string, sources: string[], n = 8): string[] {
  const grams = new Set<string>();
  for (const src of sources) {
    const t = normTokens(src);
    for (let i = 0; i + n <= t.length; i++) grams.add(t.slice(i, i + n).join(" "));
  }
  const s = normTokens(script);
  // Merge overlapping matching n-grams into whole passages.
  const hits: string[] = [];
  let runStart = -1;
  let runEnd = -1;
  for (let i = 0; i + n <= s.length; i++) {
    if (!grams.has(s.slice(i, i + n).join(" "))) continue;
    if (runStart >= 0 && i <= runEnd) {
      runEnd = i + n;
    } else {
      if (runStart >= 0) hits.push(s.slice(runStart, runEnd).join(" "));
      runStart = i;
      runEnd = i + n;
    }
  }
  if (runStart >= 0) hits.push(s.slice(runStart, runEnd).join(" "));
  return hits;
}

// ------------------------------------------------------------------ structure validation

export interface ScriptIssue {
  level: "error" | "warning";
  message: string;
}

export function normalizeScript(raw: unknown, panels: Panel[]): Script {
  const r = (raw ?? {}) as Record<string, unknown>;
  const ids = new Set(panels.map((p) => p.id));
  const segs = Array.isArray(r.segments) ? r.segments : [];
  const segments: ScriptSegment[] = segs
    .map((s) => s as Record<string, unknown>)
    .map((s) => ({
      text: String(s.text ?? "").replace(/\s+/g, " ").trim(),
      panels: (Array.isArray(s.panels) ? s.panels : []).map(String).filter((id) => ids.has(id)),
      emphasis: (Array.isArray(s.emphasis) ? s.emphasis : []).map(String).slice(0, 4),
    }))
    .filter((s) => s.text.length > 0);
  const hashtags = (Array.isArray(r.hashtags) ? r.hashtags : [])
    .map((h) => "#" + String(h).replace(/^#+/, "").replace(/[^\p{L}\p{N}_]/gu, ""))
    .filter((h) => h.length > 1)
    .slice(0, 8);
  return {
    title: String(r.title ?? "").trim().slice(0, 100),
    description: String(r.description ?? "").trim().slice(0, 4500),
    hashtags,
    hook: String(r.hook ?? "").trim(),
    segments,
  };
}

export function validateScript(
  s: Script,
  opts: { targetSeconds: number; sourceDialogues: string[]; requirePanels: boolean },
): ScriptIssue[] {
  const issues: ScriptIssue[] = [];
  if (!s.title) issues.push({ level: "error", message: "Roteiro sem título" });
  if (s.segments.length < 3) issues.push({ level: "error", message: "Roteiro com menos de 3 trechos" });
  const words = countWords(scriptText(s));
  const target = targetWords(opts.targetSeconds);
  if (words < target * 0.7 || words > target * 1.3) {
    issues.push({
      level: words < target * 0.5 || words > target * 1.6 ? "error" : "warning",
      message: `Roteiro com ${words} palavras; alvo ≈ ${target}`,
    });
  }
  const copies = copiedPassages(scriptText(s), opts.sourceDialogues);
  if (copies.length > 0) {
    issues.push({ level: "error", message: `Trechos copiados dos diálogos originais: "${copies.slice(0, 2).join('", "')}"` });
  }
  if (opts.requirePanels && s.segments.some((x) => x.panels.length === 0)) {
    issues.push({ level: "warning", message: "Alguns trechos não indicam imagens; serão usadas imagens vizinhas" });
  }
  for (const seg of s.segments) {
    if (seg.text.length > 600) issues.push({ level: "warning", message: "Trecho muito longo para uma cena" });
  }
  return issues;
}

/** Fill segments without panels with the nearest previous/next ones. */
const STOP = new Set(("a o as os um uma uns umas de do da dos das em no na nos nas por para pra com sem que e é ele ela eles elas " +
  "se seu sua seus suas mas mais como já não sim ao aos à às isso essa esse esta este lhe me te nos foi ser está era tem").split(" "));

function words(text: string): Set<string> {
  return new Set(
    text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w)),
  );
}

/**
 * Segments the model left without an image get the one that best matches
 * what is being narrated (words shared with the image description), looking
 * forward from the last image shown so the story keeps its order. Without
 * any match, the next image in reading order is used.
 */
export function fillMissingPanels(s: Script, panels: Panel[], descriptions: Record<string, string> = {}): Script {
  const order = panels.map((p) => p.id);
  const desc = new Map(order.map((id) => [id, words(descriptions[id] ?? "")]));
  let cursor = 0;
  let last: string | undefined;
  const segments = s.segments.map((seg) => {
    if (seg.panels.length > 0) {
      last = seg.panels[seg.panels.length - 1];
      cursor = Math.max(cursor, order.indexOf(last) + 1);
      return seg;
    }
    if (order.length === 0) return seg;
    const said = words(seg.text);
    let best: string | undefined;
    let bestScore = 0;
    // the next images, in order (a little back too: the narration may recap)
    const from = Math.max(0, cursor - 2);
    for (const id of order.slice(from, from + 12)) {
      let score = 0;
      for (const w of said) if (desc.get(id)?.has(w)) score++;
      if (score > bestScore) {
        bestScore = score;
        best = id;
      }
    }
    const pick = best ?? order[Math.min(cursor, order.length - 1)] ?? last;
    if (pick) {
      cursor = Math.max(cursor, order.indexOf(pick) + 1);
      last = pick;
    }
    return { ...seg, panels: pick ? [pick] : [] };
  });
  return { ...s, segments };
}
