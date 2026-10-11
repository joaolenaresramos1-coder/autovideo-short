// Turns what the user uploaded into page images, in reading order:
// images pass through (unusual formats are converted), PDFs become one image
// per page and comic archives (ZIP/CBZ/RAR/CBR/7Z) are unpacked.

import { mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { StepError } from "../supabase/functions/_shared/core/backoff.ts";
import { extOf, type UploadKind } from "../supabase/functions/_shared/core/uploads.ts";
import { run } from "./ffmpeg.ts";

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

/** Page images from one uploaded file (empty when it holds no pages). */
export async function expandUpload(file: string, kind: UploadKind, workDir: string, maxPages: number): Promise<string[]> {
  if ((await stat(file)).size === 0) return [];
  if (kind === "image") {
    const img = await toReadableImage(file, workDir, `conv-${Date.now()}`);
    return img ? [img] : [];
  }
  if (kind === "pdf") return pdfPages(file, join(workDir, `pdf-${Date.now()}`), maxPages);
  if (kind === "archive") return archivePages(file, join(workDir, `zip-${Date.now()}`), maxPages);
  return [];
}
