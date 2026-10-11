// Word-by-word captions in the style of the reference videos: one big word
// in the centre of the screen, thick outline, a few words in an accent colour.
//
// Gemini TTS does not return word timestamps, so timings are estimated:
// word duration is proportional to its length, punctuation adds pauses, and
// when the worker detected the speech intervals (ffmpeg silencedetect) words
// are laid out only inside them, which keeps captions in sync with pauses.

import type { CaptionStyle, ScriptSegment } from "./types.ts";

export interface TimedWord {
  text: string; // display text (upper-case, no trailing punctuation)
  start: number; // seconds
  end: number;
  segment: number;
  emphasis: boolean;
}

export interface SpeechInterval {
  start: number;
  end: number;
}

const PAUSE_COMMA = 2.5;
const PAUSE_SENTENCE = 5;
const PAUSE_SEGMENT = 6;

function normalizeWord(w: string): string {
  return w
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

export function displayWord(w: string): string {
  return w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}?!]+$/gu, "").toLocaleUpperCase("pt-BR");
}

interface Token {
  raw: string;
  segment: number;
  weight: number; // speaking weight
  pauseAfter: number; // silence weight after the word
  emphasis: boolean;
}

export function tokenize(segments: ScriptSegment[]): Token[] {
  const tokens: Token[] = [];
  segments.forEach((seg, si) => {
    const emph = new Set((seg.emphasis ?? []).map(normalizeWord));
    const words = seg.text.split(/\s+/).filter((w) => displayWord(w).length > 0);
    words.forEach((w, wi) => {
      const letters = displayWord(w).length;
      let pause = 0;
      if (/[.!?…]["')\]]*$/.test(w)) pause = PAUSE_SENTENCE;
      else if (/[,;:—–-]["')\]]*$/.test(w)) pause = PAUSE_COMMA;
      if (wi === words.length - 1) pause = Math.max(pause, PAUSE_SEGMENT);
      tokens.push({
        raw: w,
        segment: si,
        weight: Math.max(2, letters) + 1,
        pauseAfter: pause,
        emphasis: emph.has(normalizeWord(w)),
      });
    });
  });
  return tokens;
}

/** Map a position on the "speech-only" timeline to real time inside intervals. */
function speechTimeToReal(t: number, intervals: SpeechInterval[]): number {
  let acc = 0;
  for (const iv of intervals) {
    const len = iv.end - iv.start;
    if (t <= acc + len) return iv.start + (t - acc);
    acc += len;
  }
  const last = intervals[intervals.length - 1];
  return last ? last.end : t;
}

export function timeWords(
  segments: ScriptSegment[],
  durationSeconds: number,
  speech?: SpeechInterval[],
): TimedWord[] {
  const tokens = tokenize(segments);
  if (tokens.length === 0 || durationSeconds <= 0) return [];
  const usable = speech?.filter((s) => s.end > s.start).sort((a, b) => a.start - b.start) ?? [];

  if (usable.length > 0) {
    // Silences already come from the audio; distribute only speaking weight.
    const speechTotal = usable.reduce((a, s) => a + (s.end - s.start), 0);
    const totalWeight = tokens.reduce((a, t) => a + t.weight, 0);
    let acc = 0;
    return tokens.map((t) => {
      const s0 = (acc / totalWeight) * speechTotal;
      acc += t.weight;
      const s1 = (acc / totalWeight) * speechTotal;
      const start = speechTimeToReal(s0, usable);
      const end = Math.max(start + 0.05, speechTimeToReal(s1, usable));
      return { text: displayWord(t.raw), start: round3(start), end: round3(end), segment: t.segment, emphasis: t.emphasis };
    });
  }

  const totalWeight = tokens.reduce((a, t) => a + t.weight + t.pauseAfter, 0);
  const unit = durationSeconds / totalWeight;
  let cursor = 0;
  return tokens.map((t) => {
    const start = cursor;
    const end = start + t.weight * unit;
    cursor = end + t.pauseAfter * unit;
    return { text: displayWord(t.raw), start: round3(start), end: round3(end), segment: t.segment, emphasis: t.emphasis };
  });
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Segment time ranges derived from word timings (contiguous, covering 0..duration). */
export function segmentRanges(words: TimedWord[], segmentCount: number, duration: number): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  for (let i = 0; i < segmentCount; i++) {
    const ws = words.filter((w) => w.segment === i);
    ranges.push(ws.length ? { start: ws[0].start, end: ws[ws.length - 1].end } : { start: NaN, end: NaN });
  }
  // Make them contiguous: each segment starts where the previous ends.
  let prevEnd = 0;
  for (let i = 0; i < ranges.length; i++) {
    const nextStart = ranges.slice(i + 1).find((r) => !Number.isNaN(r.start))?.start ?? duration;
    const start = prevEnd;
    const end = i === ranges.length - 1 ? duration : Math.max(start, Number.isNaN(ranges[i].end) ? start : nextStart);
    ranges[i] = { start: round3(start), end: round3(end) };
    prevEnd = ranges[i].end;
  }
  return ranges;
}

// ------------------------------------------------------------------ ASS output

/** "#RRGGBB" -> ASS "&H00BBGGRR" */
export function assColor(hex: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) throw new Error(`Cor inválida: ${hex}`);
  return `&H00${m[3]}${m[2]}${m[1]}`.toUpperCase();
}

export function assTime(sec: number): string {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
}

function escapeAss(text: string): string {
  return text.replace(/\\/g, "＼").replace(/[{}]/g, "");
}

export interface AssOptions {
  width?: number;
  height?: number;
  fontSize?: number;
  /** Vertical position of the word, fraction of height (0.5 = centre). */
  y?: number;
}

export function buildAss(words: TimedWord[], style: CaptionStyle, opts: AssOptions = {}): string {
  const W = opts.width ?? 1080;
  const H = opts.height ?? 1920;
  const size = opts.fontSize ?? 104;
  const y = Math.round((opts.y ?? 0.5) * H);
  const primary = assColor(style.color);
  const accent = assColor(style.accent);
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Word,${style.font},${size},${primary},${primary},&H00000000,&H64000000,1,0,0,0,100,100,1,0,1,${style.outline},3,5,40,40,0,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const events = words.map((w, i) => {
    // Hold the word until the next one appears, so the screen is never empty mid-sentence.
    const next = words[i + 1];
    const end = next && next.start - w.end < 0.6 ? next.start : w.end;
    const color = w.emphasis ? `\\c${accent}` : "";
    const tags = `{\\pos(${W / 2},${y})\\fscx122\\fscy122\\t(0,90,\\fscx100\\fscy100)${color}}`;
    return `Dialogue: 0,${assTime(w.start)},${assTime(end)},Word,,0,0,0,,${tags}${escapeAss(w.text)}`;
  });
  return [...header, ...events, ""].join("\n");
}
