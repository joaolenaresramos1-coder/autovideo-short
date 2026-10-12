// Thin wrappers around the ffmpeg/ffprobe binaries.

import { spawn } from "node:child_process";
import type { Probe } from "../supabase/functions/_shared/core/validation.ts";
import type { SpeechInterval } from "../supabase/functions/_shared/core/captions.ts";

export interface RunResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

export function run(cmd: string, args: string[], opts: { timeoutMs?: number; input?: Buffer; cwd?: string } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], cwd: opts.cwd });
    const out: Buffer[] = [];
    let err = "";
    const timer = opts.timeoutMs ? setTimeout(() => p.kill("SIGKILL"), opts.timeoutMs) : null;
    p.stdout.on("data", (d: Buffer) => out.push(d));
    p.stderr.on("data", (d: Buffer) => {
      err += d.toString();
      if (err.length > 200_000) err = err.slice(-100_000);
    });
    p.on("error", reject);
    p.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr: err });
    });
    if (opts.input) p.stdin.end(opts.input);
    else p.stdin.end();
  });
}

export async function ffprobe(file: string): Promise<Probe> {
  const r = await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], { timeoutMs: 60_000 });
  if (r.code !== 0) throw new Error(`ffprobe falhou: ${r.stderr.slice(-500)}`);
  return JSON.parse(r.stdout.toString()) as Probe;
}

export async function imageSize(file: string): Promise<{ width: number; height: number }> {
  const p = await ffprobe(file);
  const v = p.streams?.find((s) => s.codec_type === "video");
  if (!v?.width || !v.height) throw new Error(`Imagem inválida: ${file}`);
  return { width: v.width, height: v.height };
}

/** Full decode of the file; returns ffmpeg's error output (empty = clean). */
export async function decodeErrors(file: string): Promise<string> {
  const r = await run("ffmpeg", ["-v", "error", "-i", file, "-f", "null", "-"], { timeoutMs: 600_000 });
  return r.code === 0 ? r.stderr.trim() : `exit ${r.code}: ${r.stderr.slice(-1000)}`;
}

/** Non-silent intervals of a narration (used to sync captions with pauses). */
export async function speechIntervals(file: string, duration: number, noiseDb = -35, minSilence = 0.25): Promise<SpeechInterval[]> {
  const r = await run("ffmpeg", ["-hide_banner", "-i", file, "-af", `silencedetect=noise=${noiseDb}dB:d=${minSilence}`, "-f", "null", "-"], { timeoutMs: 120_000 });
  const silences: { start: number; end: number }[] = [];
  let open: number | null = null;
  for (const line of r.stderr.split("\n")) {
    const s = /silence_start: (-?[\d.]+)/.exec(line);
    const e = /silence_end: ([\d.]+)/.exec(line);
    if (s) open = Math.max(0, Number(s[1]));
    if (e && open !== null) {
      silences.push({ start: open, end: Number(e[1]) });
      open = null;
    }
  }
  if (open !== null) silences.push({ start: open, end: duration });
  const speech: SpeechInterval[] = [];
  let cursor = 0;
  for (const s of silences) {
    if (s.start > cursor + 0.05) speech.push({ start: cursor, end: s.start });
    cursor = Math.max(cursor, s.end);
  }
  if (cursor < duration - 0.05) speech.push({ start: cursor, end: duration });
  return speech;
}

/** Luma standard deviation of a downscaled image: ~0 for blank panels. */
export async function lumaStdDev(file: string, crop?: { y: number; h: number }): Promise<number> {
  const vf = [crop ? `crop=iw:${crop.h}:0:${crop.y}` : null, "scale=48:-2", "format=gray"].filter(Boolean).join(",");
  const r = await run("ffmpeg", ["-v", "error", "-i", file, "-vf", vf, "-frames:v", "1", "-f", "rawvideo", "-"], { timeoutMs: 60_000 });
  if (r.code !== 0 || r.stdout.length === 0) return 0;
  const px = r.stdout;
  let sum = 0;
  for (const v of px) sum += v;
  const mean = sum / px.length;
  let sq = 0;
  for (const v of px) sq += (v - mean) ** 2;
  return Math.sqrt(sq / px.length);
}

export async function ffmpegOk(): Promise<boolean> {
  try {
    return (await run("ffmpeg", ["-version"], { timeoutMs: 10_000 })).code === 0;
  } catch {
    return false;
  }
}
