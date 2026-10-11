// YouTube Data API v3 — resumable upload + confirmation.
// https://developers.google.com/youtube/v3/docs/videos/insert

import { StepError } from "../core/backoff.ts";
import type { ByteSource } from "./bytes.ts";
import { type FetchLike, ensureOk, http, httpJson } from "./http.ts";

const API = "https://www.googleapis.com/youtube/v3";
const UPLOAD = "https://www.googleapis.com/upload/youtube/v3/videos";
/** Chunks must be multiples of 256 KiB. */
export const YT_CHUNK = 8 * 1024 * 1024;

export interface YouTubeMetadata {
  title: string;
  description: string;
  tags: string[];
  privacyStatus: "private" | "unlisted" | "public";
  /** Scheduled publication (requires privacyStatus=private while waiting). */
  publishAt?: string;
  containsSyntheticMedia?: boolean;
  categoryId?: string;
}

export interface ChannelInfo {
  id: string;
  title: string;
}

export async function myChannel(fetchFn: FetchLike, accessToken: string): Promise<ChannelInfo> {
  const r = await httpJson<{ items?: { id: string; snippet: { title: string } }[] }>(
    fetchFn,
    `${API}/channels?part=snippet&mine=true`,
    { headers: { authorization: `Bearer ${accessToken}` }, service: "YouTube" },
  );
  const c = r.items?.[0];
  if (!c) throw new StepError("Esta conta Google não tem canal do YouTube", "config");
  return { id: c.id, title: c.snippet.title };
}

export function buildVideoResource(m: YouTubeMetadata) {
  const scheduled = m.publishAt && new Date(m.publishAt).getTime() > Date.now() + 15 * 60_000;
  return {
    snippet: {
      title: m.title.slice(0, 100),
      description: m.description.slice(0, 5000),
      tags: m.tags.map((t) => t.replace(/^#/, "")).slice(0, 15),
      categoryId: m.categoryId ?? "24",
      defaultLanguage: "pt-BR",
      defaultAudioLanguage: "pt-BR",
    },
    status: {
      privacyStatus: scheduled ? "private" : m.privacyStatus,
      ...(scheduled ? { publishAt: new Date(m.publishAt!).toISOString() } : {}),
      selfDeclaredMadeForKids: false,
      containsSyntheticMedia: m.containsSyntheticMedia ?? false,
      embeddable: true,
    },
  };
}

/** Step 1: open an upload session. Returns the session URI (store it to resume). */
export async function startResumableUpload(
  fetchFn: FetchLike,
  accessToken: string,
  meta: YouTubeMetadata,
  size: number,
  contentType = "video/mp4",
): Promise<string> {
  const res = await ensureOk(
    await http(fetchFn, `${UPLOAD}?uploadType=resumable&part=snippet,status`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json; charset=UTF-8",
        "x-upload-content-length": String(size),
        "x-upload-content-type": contentType,
      },
      body: JSON.stringify(buildVideoResource(meta)),
      service: "YouTube",
    }),
    "YouTube",
  );
  const location = res.headers.get("location");
  if (!location) throw new StepError("YouTube não retornou a sessão de upload", "retryable");
  return location;
}

function nextOffset(res: Response): number {
  const range = res.headers.get("range"); // "bytes=0-1048575"
  const m = range && /bytes=\d+-(\d+)/.exec(range);
  return m ? Number(m[1]) + 1 : 0;
}

/** Ask the session how many bytes it already has (resume after a failure). */
export async function queryUploadOffset(
  fetchFn: FetchLike,
  sessionUri: string,
  size: number,
): Promise<{ done: true; video: { id: string } } | { done: false; offset: number }> {
  const res = await http(fetchFn, sessionUri, {
    method: "PUT",
    headers: { "content-range": `bytes */${size}`, "content-length": "0" },
    service: "YouTube",
  });
  if (res.status === 200 || res.status === 201) return { done: true, video: await res.json() };
  if (res.status === 308) return { done: false, offset: nextOffset(res) };
  if (res.status === 404 || res.status === 410) {
    throw new StepError("Sessão de upload do YouTube expirou", "retryable");
  }
  await ensureOk(res, "YouTube");
  return { done: false, offset: 0 };
}

/**
 * Step 2: send bytes from `offset`, chunk by chunk, until YouTube returns the
 * video resource. `deadline` lets an Edge Function stop before its time limit
 * (the session URI allows continuing on the next run).
 */
export async function uploadChunks(
  fetchFn: FetchLike,
  sessionUri: string,
  source: ByteSource,
  offset: number,
  deadline: number,
): Promise<{ done: true; video: { id: string; status?: { uploadStatus?: string } } } | { done: false; offset: number }> {
  let pos = offset;
  while (pos < source.size) {
    if (Date.now() > deadline) return { done: false, offset: pos };
    const end = Math.min(pos + YT_CHUNK, source.size);
    const chunk = await source.read(pos, end);
    const res = await http(fetchFn, sessionUri, {
      method: "PUT",
      headers: {
        "content-type": source.contentType,
        "content-length": String(chunk.length),
        "content-range": `bytes ${pos}-${end - 1}/${source.size}`,
      },
      body: chunk as BodyInit,
      service: "YouTube",
      timeoutMs: 120_000,
    });
    if (res.status === 200 || res.status === 201) return { done: true, video: await res.json() };
    if (res.status !== 308) await ensureOk(res, "YouTube");
    pos = nextOffset(res);
  }
  const final = await queryUploadOffset(fetchFn, sessionUri, source.size);
  return final;
}

export interface YouTubeStatus {
  exists: boolean;
  uploadStatus?: string; // uploaded | processed | failed | rejected | deleted
  privacyStatus?: string;
  publishAt?: string;
  failureReason?: string;
  rejectionReason?: string;
  processingStatus?: string;
}

export async function videoStatus(fetchFn: FetchLike, accessToken: string, videoId: string): Promise<YouTubeStatus> {
  const r = await httpJson<{
    items?: {
      status?: { uploadStatus?: string; privacyStatus?: string; publishAt?: string; failureReason?: string; rejectionReason?: string };
      processingDetails?: { processingStatus?: string };
    }[];
  }>(fetchFn, `${API}/videos?part=status,processingDetails&id=${encodeURIComponent(videoId)}`, {
    headers: { authorization: `Bearer ${accessToken}` },
    service: "YouTube",
  });
  const v = r.items?.[0];
  if (!v) return { exists: false };
  return {
    exists: true,
    uploadStatus: v.status?.uploadStatus,
    privacyStatus: v.status?.privacyStatus,
    publishAt: v.status?.publishAt,
    failureReason: v.status?.failureReason,
    rejectionReason: v.status?.rejectionReason,
    processingStatus: v.processingDetails?.processingStatus,
  };
}

export type ConfirmedState = "processing" | "scheduled" | "published" | "failed";

/** Only declare "published" when YouTube says the video is processed. */
export function interpretYouTubeStatus(s: YouTubeStatus, now = new Date()): { state: ConfirmedState; detail: string } {
  if (!s.exists) return { state: "failed", detail: "Vídeo não encontrado no YouTube" };
  if (s.uploadStatus === "failed" || s.uploadStatus === "rejected" || s.uploadStatus === "deleted") {
    return { state: "failed", detail: `YouTube: ${s.uploadStatus} ${s.failureReason ?? s.rejectionReason ?? ""}`.trim() };
  }
  if (s.uploadStatus !== "processed") return { state: "processing", detail: `YouTube processando (${s.processingStatus ?? s.uploadStatus})` };
  if (s.publishAt && new Date(s.publishAt) > now && s.privacyStatus === "private") {
    return { state: "scheduled", detail: `Agendado no YouTube para ${s.publishAt}` };
  }
  return { state: "published", detail: `Processado no YouTube (${s.privacyStatus})` };
}
