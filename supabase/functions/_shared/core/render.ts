// Render plan (which panel is on screen when, with which movement) and the
// FFmpeg command that executes it. Pure functions: the worker only runs them.

import type { Panel, ScriptSegment } from "./types.ts";

export type Motion = "zoom_in" | "zoom_out" | "pan_down" | "pan_up" | "pan_right" | "pan_left";

export interface Shot {
  panelId: string;
  start: number;
  duration: number;
  motion: Motion;
}

export const OUTPUT = { width: 1080, height: 1920, fps: 30 } as const;
const MAX_SHOT_SECONDS = 4.5;
const MIN_SHOT_SECONDS = 0.6;

/**
 * One movement per image, always in the same direction for the same kind of
 * image: tall strips scroll down (reading order), wide panels slide right,
 * the rest get a slow push-in. No alternating in/out or up/down, which looks
 * like the image is bouncing back and forth.
 */
function motionFor(panel: Panel | undefined): Motion {
  if (panel) {
    const ratio = panel.height / panel.width;
    if (ratio > (16 / 9) * 1.2) return "pan_down";
    if (ratio < 1) return "pan_right";
  }
  return "zoom_in";
}

/**
 * Build contiguous shots covering [0, duration). Each narration segment shows
 * the images it names, in order, while it is being spoken. A long segment with
 * a single image also shows the other slices of the same page (same scene).
 * The same image on consecutive shots becomes one continuous shot, so the
 * movement never restarts in the middle.
 */
export function planShots(
  segments: ScriptSegment[],
  ranges: { start: number; end: number }[],
  panels: Panel[],
  duration: number,
): Shot[] {
  if (panels.length === 0) throw new Error("Nenhuma imagem disponível para o vídeo");
  const byId = new Map(panels.map((p) => [p.id, p]));
  const order = panels.map((p) => p.id);
  const raw: Omit<Shot, "motion">[] = [];
  let lastId: string | undefined;
  segments.forEach((seg, i) => {
    const r = ranges[i];
    const len = r.end - r.start;
    if (!(len > 0)) return;
    let ids = seg.panels.filter((id) => byId.has(id));
    // nothing named: keep the image that is on screen (same moment of the story)
    if (ids.length === 0) ids = [lastId ?? order[0]];
    const wanted = Math.ceil(len / MAX_SHOT_SECONDS);
    if (ids.length < wanted) {
      const extra: string[] = [];
      for (const id of ids) {
        const page = byId.get(id)?.page;
        if (page === undefined) continue;
        const at = order.indexOf(id);
        for (const other of order.slice(at + 1)) {
          if (byId.get(other)?.page !== page) break;
          if (!ids.includes(other) && !extra.includes(other)) extra.push(other);
        }
      }
      ids = [...ids, ...extra].slice(0, wanted).sort((a, b) => order.indexOf(a) - order.indexOf(b));
    }
    const each = len / ids.length;
    ids.forEach((id, k) => raw.push({ panelId: id, start: r.start + k * each, duration: each }));
    lastId = ids[ids.length - 1];
  });
  // Same image twice in a row: one continuous shot. Very short shots join the previous one.
  const merged: Omit<Shot, "motion">[] = [];
  for (const s of raw) {
    const prev = merged[merged.length - 1];
    if (prev && (prev.panelId === s.panelId || s.duration < MIN_SHOT_SECONDS)) prev.duration += s.duration;
    else merged.push({ ...s });
  }
  // Snap to frames and make sure the plan covers exactly `duration`.
  const frame = 1 / OUTPUT.fps;
  let t = 0;
  for (let i = 0; i < merged.length; i++) {
    const s = merged[i];
    s.start = t;
    const end = i === merged.length - 1 ? duration : Math.round((s.start + s.duration) / frame) * frame;
    s.duration = Math.max(frame, end - s.start);
    t = s.start + s.duration;
  }
  return merged.map((s) => ({ ...s, motion: motionFor(byId.get(s.panelId)), start: round(s.start), duration: round(s.duration) }));
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export interface FfmpegJob {
  shots: Shot[];
  /** panel id -> local image file */
  images: Record<string, string>;
  audioPath: string;
  assPath: string;
  fontsDir?: string;
  musicPath?: string;
  musicVolume?: number;
  /** atempo applied to the narration (0.9..1.1) */
  tempo?: number;
  /** total output duration in seconds */
  duration: number;
  outputPath: string;
  preset?: string;
  crf?: number;
  /** Cap on the video bitrate so the file fits the storage upload limit. */
  maxVideoKbps?: number;
}

/** Supabase Free rejects uploads above 50 MB: keep a margin. */
export const MAX_FILE_BYTES = 48 * 1024 * 1024;
const AUDIO_KBPS = 160;

/** Highest video bitrate that keeps a file of `duration` seconds under `maxBytes`. */
export function videoBitrateFor(duration: number, maxBytes = MAX_FILE_BYTES): number {
  const totalKbps = (maxBytes * 8) / 1000 / Math.max(1, duration);
  return Math.max(1000, Math.min(8000, Math.floor(totalKbps * 0.92 - AUDIO_KBPS)));
}

function motionFilter(m: Motion, d: number): string {
  const { width: W, height: H, fps } = OUTPUT;
  const D = d.toFixed(3);
  const frames = Math.max(1, Math.round(d * fps));
  // slow, constant speed: about 2.5% per second, at most 12% per shot
  const z = Math.min(0.12, 0.025 * d).toFixed(4);
  switch (m) {
    case "zoom_in":
    case "zoom_out": {
      // zoompan on a 2x copy: sub-pixel steps, so the push-in does not shake
      const zoom = m === "zoom_in" ? `1+${z}*on/${frames}` : `1+${z}*(1-on/${frames})`;
      return `scale=${2 * W}:${2 * H}:force_original_aspect_ratio=increase,crop=${2 * W}:${2 * H},` +
        `zoompan=z='${zoom}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${fps}`;
    }
    case "pan_down":
      return `scale=${W}:-2,crop=${W}:${H}:0:'(ih-oh)*min(1,t/${D})'`;
    case "pan_up":
      return `scale=${W}:-2,crop=${W}:${H}:0:'(ih-oh)*(1-min(1,t/${D}))'`;
    case "pan_right":
      return `scale=-2:${H},crop=${W}:${H}:'(iw-ow)*min(1,t/${D})':0`;
    case "pan_left":
      return `scale=-2:${H},crop=${W}:${H}:'(iw-ow)*(1-min(1,t/${D}))':0`;
  }
}

/** Escape a path for use inside an FFmpeg filter argument. */
export function filterPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'").replace(/,/g, "\\,");
}

export function buildFfmpegArgs(job: FfmpegJob): string[] {
  const { width: W, height: H, fps } = OUTPUT;
  const args: string[] = ["-hide_banner", "-y"];
  const parts: string[] = [];
  job.shots.forEach((s, i) => {
    const img = job.images[s.panelId];
    if (!img) throw new Error(`Imagem ausente para o painel ${s.panelId}`);
    args.push("-loop", "1", "-framerate", String(fps), "-t", s.duration.toFixed(3), "-i", img);
    parts.push(
      `[${i}:v]${motionFilter(s.motion, s.duration)},setsar=1,fps=${fps},format=yuv420p,` +
        `trim=duration=${s.duration.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`,
    );
  });
  const audioIdx = job.shots.length;
  args.push("-i", job.audioPath);
  let musicIdx = -1;
  if (job.musicPath) {
    musicIdx = audioIdx + 1;
    args.push("-stream_loop", "-1", "-i", job.musicPath);
  }

  const concatIn = job.shots.map((_, i) => `[v${i}]`).join("");
  const fonts = job.fontsDir ? `:fontsdir='${filterPath(job.fontsDir)}'` : "";
  parts.push(
    `${concatIn}concat=n=${job.shots.length}:v=1:a=0,` +
      // subtle colour fringe + slight saturation boost, as in the references
      `rgbashift=rh=-2:bh=2,eq=saturation=1.08,` +
      `subtitles='${filterPath(job.assPath)}'${fonts},format=yuv420p[vout]`,
  );
  const tempo = job.tempo && Math.abs(job.tempo - 1) > 0.001 ? `,atempo=${job.tempo.toFixed(4)}` : "";
  if (musicIdx >= 0) {
    const vol = (job.musicVolume ?? 0.12).toFixed(3);
    parts.push(`[${audioIdx}:a]aresample=48000${tempo},apad[narr]`);
    parts.push(`[${musicIdx}:a]aresample=48000,volume=${vol}[mus]`);
    parts.push(`[narr][mus]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95[aout]`);
  } else {
    parts.push(`[${audioIdx}:a]aresample=48000${tempo},apad[aout]`);
  }

  args.push(
    "-filter_complex", parts.join(";"),
    "-map", "[vout]", "-map", "[aout]",
    "-t", job.duration.toFixed(3),
    "-r", String(fps),
    "-s", `${W}x${H}`,
    "-c:v", "libx264", "-preset", job.preset ?? "veryfast", "-crf", String(job.crf ?? 21),
    "-maxrate", `${job.maxVideoKbps ?? videoBitrateFor(job.duration)}k`,
    "-bufsize", `${(job.maxVideoKbps ?? videoBitrateFor(job.duration)) * 2}k`,
    "-pix_fmt", "yuv420p", "-profile:v", "high",
    "-c:a", "aac", "-b:a", `${AUDIO_KBPS}k`, "-ar", "48000",
    "-movflags", "+faststart",
    job.outputPath,
  );
  return args;
}
