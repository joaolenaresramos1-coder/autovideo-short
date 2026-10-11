// Turns what the user uploaded into page images, in reading order:
// images pass through (unusual formats are converted), PDFs become one image
// per page, comic archives (ZIP/CBZ/RAR/CBR/7Z) are unpacked and videos give
// one frame per scene (plus their subtitles, when the file has them).

import { mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { StepError } from "../supabase/functions/_shared/core/backoff.ts";
import { extOf, type UploadKind } from "../supabase/functions/_shared/core/uploads.ts";
import { ffprobe, run } from "./ffmpeg.ts";

const DIRECT = new Set(["jpg", "jpeg", "jfif", "png", "webp", "bmp", "gif", "tif", "tiff"]);
const IMAGE_EXT = /\.(jpe?g|jfif|png|webp|gif|bmp|tiff?|avif|heic|heif)$/i;
const PDF_DPI = "110";

export const naturalCompare = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "__MACOSX") out.push(...(await listFiles(p)));
    } else if (!e.name.startsWith(".")) {
      out.push(p);
    }
  }
  return out;
}

/** HEIC/AVIF and other formats ffprobe may not read become PNG. */
async function toReadableImage(file: string, outDir: string, tag: string): Promise<string | null> {
  const ext = extOf(file);
  if (DIRECT.has(ext)) return file;
  const out = join(outDir, `${tag}.png`);
  if (ext === "heic" || ext === "heif") {
    const r = await run("heif-convert", [file, out], { timeoutMs: 120_000 }).catch(() => null);
    if (r?.code === 0) return out;
  }
  const r = await run("ffmpeg", ["-v", "error", "-y", "-i", file, "-frames:v", "1", out], { timeoutMs: 120_000 });
  if (r.code === 0) return out;
  const m = await run("convert", [`${file}[0]`, out], { timeoutMs: 120_000 }).catch(() => null);
  return m?.code === 0 ? out : null;
}

async function pdfPages(file: string, outDir: string, maxPages: number): Promise<string[]> {
  await mkdir(outDir, { recursive: true });
  const r = await run("pdftoppm", ["-r", PDF_DPI, "-jpeg", "-jpegopt", "quality=90", "-l", String(maxPages), file, join(outDir, "p")], { timeoutMs: 600_000 });
  if (r.code !== 0) throw new StepError(`Não consegui abrir o PDF: ${r.stderr.slice(-300)}`, "permanent");
  return (await readdir(outDir)).filter((f) => f.endsWith(".jpg")).sort(naturalCompare).map((f) => join(outDir, f));
}

async function archivePages(file: string, outDir: string, maxPages: number): Promise<string[]> {
  await mkdir(outDir, { recursive: true });
  const r = await run("7z", ["x", "-y", "-bd", `-o${outDir}`, file], { timeoutMs: 600_000 });
  if (r.code !== 0 && r.code !== 1) throw new StepError(`Não consegui abrir o arquivo compactado: ${r.stderr.slice(-300)}`, "permanent");
  const all = (await listFiles(outDir)).sort(naturalCompare);
  const pages: string[] = [];
  for (const f of all) {
    if (pages.length >= maxPages) break;
    if (IMAGE_EXT.test(f)) {
      const img = await toReadableImage(f, outDir, `img-${pages.length}`);
      if (img) pages.push(img);
    } else if (/\.pdf$/i.test(f)) {
      pages.push(...(await pdfPages(f, join(outDir, `pdf-${pages.length}`), maxPages - pages.length)));
    }
  }
  return pages;
}

const VIDEO_FRAMES = 80;

/** One frame per scene change; evenly spaced frames when the video has few cuts. */
async function videoFrames(file: string, outDir: string, maxPages: number): Promise<string[]> {
  await mkdir(outDir, { recursive: true });
  const limit = Math.max(1, Math.min(VIDEO_FRAMES, maxPages));
  const probe = await ffprobe(file).catch(() => null);
  const duration = Number(probe?.format?.duration ?? 0);
  if (!probe?.streams?.some((s) => s.codec_type === "video")) throw new StepError("O vídeo enviado não tem imagem legível", "permanent");
  const list = async (prefix: string) => (await readdir(outDir)).filter((f) => f.startsWith(prefix)).sort(naturalCompare).map((f) => join(outDir, f));

  const scene = await run("ffmpeg", [
    "-v", "error", "-y", "-i", file, "-an", "-sn",
    "-vf", "select='gt(scene,0.32)',scale='min(1080,iw)':-2", "-fps_mode", "vfr", "-frames:v", String(limit), "-q:v", "3",
    join(outDir, "s-%04d.jpg"),
  ], { timeoutMs: 900_000 });
  let frames = scene.code === 0 ? await list("s-") : [];
  if (frames.length < Math.min(12, limit) && duration > 0) {
    // few cuts (or detection failed): sample the whole video evenly
    const n = Math.min(limit, Math.max(8, Math.round(duration / 4)));
    const r = await run("ffmpeg", [
      "-v", "error", "-y", "-i", file, "-an", "-sn",
      "-vf", `fps=${(n / duration).toFixed(5)},scale='min(1080,iw)':-2`, "-frames:v", String(n), "-q:v", "3",
      join(outDir, "e-%04d.jpg"),
    ], { timeoutMs: 900_000 });
    if (r.code === 0) frames = await list("e-");
  }
  if (frames.length === 0) throw new StepError("Não consegui tirar imagens do vídeo enviado", "permanent");
  return frames;
}

/** Subtitles inside a video file (MKV/MP4), as SRT text; null when there are none. */
export async function videoSubtitles(file: string, outDir: string): Promise<string | null> {
  const probe = await ffprobe(file).catch(() => null);
  if (!probe?.streams?.some((s) => s.codec_type === "subtitle")) return null;
  await mkdir(outDir, { recursive: true });
  const out = join(outDir, "legendas.srt");
  const r = await run("ffmpeg", ["-v", "error", "-y", "-i", file, "-map", "0:s:0", "-c:s", "srt", out], { timeoutMs: 300_000 });
  return r.code === 0 && (await stat(out)).size > 0 ? out : null;
}

/** Page images from one uploaded file (empty when it holds no pages). */
export async function expandUpload(file: string, kind: UploadKind, workDir: string, maxPages: number): Promise<string[]> {
  if ((await stat(file)).size === 0) return [];
  if (kind === "image") {
    const img = await toReadableImage(file, workDir, `conv-${Date.now()}`);
    return img ? [img] : [];
  }
  if (kind === "pdf") return pdfPages(file, join(workDir, `pdf-${Date.now()}`), maxPages);
  if (kind === "archive") return archivePages(file, join(workDir, `zip-${Date.now()}`), maxPages);
  if (kind === "video") return videoFrames(file, join(workDir, `vid-${Date.now()}`), maxPages);
  return [];
}
