// File types accepted for a chapter: page images, PDFs, comic archives
// (ZIP/CBZ/RAR/CBR/7Z) and text (script, subtitles). Shared by the API,
// the panel and the worker so all three agree.

export type UploadKind = "image" | "pdf" | "archive" | "text";

/** 50 MB: the Supabase Free per-file upload limit. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

const BY_EXT: Record<string, { kind: UploadKind; type: string }> = {
  jpg: { kind: "image", type: "image/jpeg" },
  jpeg: { kind: "image", type: "image/jpeg" },
  jfif: { kind: "image", type: "image/jpeg" },
  png: { kind: "image", type: "image/png" },
  webp: { kind: "image", type: "image/webp" },
  gif: { kind: "image", type: "image/gif" },
  bmp: { kind: "image", type: "image/bmp" },
  tif: { kind: "image", type: "image/tiff" },
  tiff: { kind: "image", type: "image/tiff" },
  avif: { kind: "image", type: "image/avif" },
  heic: { kind: "image", type: "image/heic" },
  heif: { kind: "image", type: "image/heif" },
  pdf: { kind: "pdf", type: "application/pdf" },
  zip: { kind: "archive", type: "application/zip" },
  cbz: { kind: "archive", type: "application/vnd.comicbook+zip" },
  rar: { kind: "archive", type: "application/vnd.rar" },
  cbr: { kind: "archive", type: "application/vnd.comicbook-rar" },
  "7z": { kind: "archive", type: "application/x-7z-compressed" },
  cb7: { kind: "archive", type: "application/x-7z-compressed" },
  txt: { kind: "text", type: "text/plain" },
  srt: { kind: "text", type: "application/x-subrip" },
  vtt: { kind: "text", type: "text/vtt" },
};

const ARCHIVE_TYPES = /zip|rar|7z|comicbook|compressed/;

export function extOf(name: string): string {
  return /\.([a-z0-9]+)$/i.exec(name)?.[1].toLowerCase() ?? "";
}

/** What a file is, from its name first (phones often send an empty or generic type). */
export function uploadKind(contentType: string | null | undefined, name: string): UploadKind | null {
  const byExt = BY_EXT[extOf(name)];
  if (byExt) return byExt.kind;
  const ct = (contentType ?? "").toLowerCase();
  if (ct.startsWith("image/")) return "image";
  if (ct === "application/pdf") return "pdf";
  if (ARCHIVE_TYPES.test(ct)) return "archive";
  if (ct.startsWith("text/") || ct.includes("subrip")) return "text";
  return null;
}

/** Content type to store the file with. */
export function uploadContentType(contentType: string | null | undefined, name: string): string {
  const byExt = BY_EXT[extOf(name)];
  if (byExt) return byExt.type;
  return (contentType || "application/octet-stream").toLowerCase();
}

/** For <input accept>. */
export const UPLOAD_ACCEPT = "image/*,application/pdf,.pdf,.zip,.cbz,.rar,.cbr,.7z,.cb7,.heic,.heif,.txt,.srt,.vtt";
export const UPLOAD_HINT = "Imagens (JPG, PNG, WebP, GIF, HEIC…), PDF, ZIP/CBZ/RAR/CBR ou texto (TXT, SRT, VTT). Até 50 MB cada.";
