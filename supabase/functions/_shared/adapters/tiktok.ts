// TikTok Content Posting API — Direct Post (FILE_UPLOAD).
// https://developers.tiktok.com/doc/content-posting-api-reference-direct-post
// Unaudited apps can only post with privacy SELF_ONLY (private).

import { StepError } from "../core/backoff.ts";
import type { ByteSource } from "./bytes.ts";
import { type FetchLike, ensureOk, http } from "./http.ts";

const API = "https://open.tiktokapis.com/v2";
const MB = 1024 * 1024;

interface TikTokEnvelope<T> {
  data?: T;
  error?: { code?: string; message?: string; log_id?: string; logid?: string };
}

const CONFIG_ERRORS = new Set([
  "access_token_invalid",
  "scope_not_authorized",
  "unaudited_client_can_only_post_to_private_accounts",
  "privacy_level_option_mismatch",
  "url_ownership_unverified",
  "spam_risk_user_banned_from_posting",
]);

async function call<T>(fetchFn: FetchLike, path: string, token: string, body: unknown): Promise<T> {
  const res = await http(fetchFn, `${API}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=UTF-8" },
    body: JSON.stringify(body),
    service: "TikTok",
  });
  const env = (await res.json().catch(() => ({}))) as TikTokEnvelope<T>;
  const code = env.error?.code ?? (res.ok ? "ok" : `http_${res.status}`);
  if (code !== "ok") {
    const kind = CONFIG_ERRORS.has(code) ? "config" : res.status === 429 || res.status >= 500 || code === "rate_limit_exceeded" ? "retryable" : "permanent";
    const hint = code === "unaudited_client_can_only_post_to_private_accounts"
      ? " — app TikTok não auditado: só publica em contas privadas (SELF_ONLY)"
      : "";
    throw new StepError(`TikTok: ${code} ${env.error?.message ?? ""}${hint}`.trim(), kind);
  }
  return env.data as T;
}

export interface CreatorInfo {
  creator_username?: string;
  creator_nickname?: string;
  privacy_level_options: string[];
  comment_disabled?: boolean;
  duet_disabled?: boolean;
  stitch_disabled?: boolean;
  max_video_post_duration_sec?: number;
}

export function creatorInfo(fetchFn: FetchLike, token: string): Promise<CreatorInfo> {
  return call<CreatorInfo>(fetchFn, "/post/publish/creator_info/query/", token, {});
}

export async function userInfo(fetchFn: FetchLike, token: string): Promise<{ open_id: string; display_name?: string }> {
  const res = await ensureOk(
    await http(fetchFn, `${API}/user/info/?fields=open_id,display_name`, {
      headers: { authorization: `Bearer ${token}` },
      service: "TikTok",
    }),
    "TikTok",
  );
  const env = (await res.json()) as TikTokEnvelope<{ user: { open_id: string; display_name?: string } }>;
  if (!env.data?.user) throw new StepError("TikTok não retornou o usuário", "retryable");
  return env.data.user;
}

/** Chunking rules from the Media Transfer Guide: 5–64 MB chunks, last chunk
 * absorbs the remainder (≤128 MB), files ≤64 MB may go in one chunk. */
export function chunkPlan(size: number): { chunkSize: number; total: number } {
  if (size <= 64 * MB) return { chunkSize: size, total: 1 };
  const chunkSize = 10 * MB;
  return { chunkSize, total: Math.floor(size / chunkSize) };
}

export function choosePrivacy(wanted: string, info: CreatorInfo): string {
  if (info.privacy_level_options.includes(wanted)) return wanted;
  if (info.privacy_level_options.includes("SELF_ONLY")) return "SELF_ONLY";
  throw new StepError(`Privacidade ${wanted} indisponível para esta conta TikTok`, "config");
}

export interface TikTokPostInput {
  title: string;
  privacy: string;
  isAigc: boolean;
  durationSeconds: number;
}

export async function initDirectPost(
  fetchFn: FetchLike,
  token: string,
  input: TikTokPostInput,
  size: number,
): Promise<{ publishId: string; uploadUrl: string; privacy: string }> {
  const info = await creatorInfo(fetchFn, token);
  if (info.max_video_post_duration_sec && input.durationSeconds > info.max_video_post_duration_sec) {
    throw new StepError(`Vídeo de ${Math.round(input.durationSeconds)} s excede o limite da conta TikTok (${info.max_video_post_duration_sec} s)`, "permanent");
  }
  const privacy = choosePrivacy(input.privacy, info);
  const { chunkSize, total } = chunkPlan(size);
  const data = await call<{ publish_id: string; upload_url: string }>(fetchFn, "/post/publish/video/init/", token, {
    post_info: {
      title: input.title.slice(0, 2200),
      privacy_level: privacy,
      disable_duet: !!info.duet_disabled,
      disable_stitch: !!info.stitch_disabled,
      disable_comment: !!info.comment_disabled,
      video_cover_timestamp_ms: 1000,
      brand_content_toggle: false,
      brand_organic_toggle: false,
      is_aigc: input.isAigc,
    },
    source_info: { source: "FILE_UPLOAD", video_size: size, chunk_size: chunkSize, total_chunk_count: total },
  });
  return { publishId: data.publish_id, uploadUrl: data.upload_url, privacy };
}

export async function uploadTikTok(fetchFn: FetchLike, uploadUrl: string, source: ByteSource): Promise<void> {
  const { chunkSize, total } = chunkPlan(source.size);
  for (let i = 0; i < total; i++) {
    const start = i * chunkSize;
    const end = i === total - 1 ? source.size : start + chunkSize;
    const bytes = await source.read(start, end);
    const res = await http(fetchFn, uploadUrl, {
      method: "PUT",
      headers: {
        "content-type": source.contentType,
        "content-length": String(bytes.length),
        "content-range": `bytes ${start}-${end - 1}/${source.size}`,
      },
      body: bytes as BodyInit,
      service: "TikTok",
      timeoutMs: 120_000,
    });
    if (!(res.status === 201 || res.status === 206 || res.ok)) await ensureOk(res, "TikTok");
  }
}

export interface TikTokStatus {
  status: string; // PROCESSING_UPLOAD | PROCESSING_DOWNLOAD | SEND_TO_USER_INBOX | PUBLISH_COMPLETE | FAILED
  fail_reason?: string;
  publicaly_available_post_id?: (string | number)[];
}

export function postStatus(fetchFn: FetchLike, token: string, publishId: string): Promise<TikTokStatus> {
  return call<TikTokStatus>(fetchFn, "/post/publish/status/fetch/", token, { publish_id: publishId });
}

export function interpretTikTokStatus(s: TikTokStatus): { state: "processing" | "published" | "failed"; detail: string; postId?: string } {
  if (s.status === "PUBLISH_COMPLETE") {
    const id = s.publicaly_available_post_id?.[0];
    return { state: "published", detail: "TikTok confirmou a publicação", postId: id ? String(id) : undefined };
  }
  if (s.status === "FAILED") return { state: "failed", detail: `TikTok: ${s.fail_reason ?? "falha"}` };
  return { state: "processing", detail: `TikTok: ${s.status}` };
}
