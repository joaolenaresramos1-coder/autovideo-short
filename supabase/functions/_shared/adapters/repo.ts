// Data access used by the pipeline. Production uses SupabaseRepo
// (supabase-js + service role); tests use a node-postgres implementation of
// the same interface against the real migrations.

import type { Sealed } from "../core/crypto.ts";
import type { MemoryEntry } from "../core/memory.ts";
import type { Executor, JobState } from "../core/states.ts";
import type { Chapter, Job, Platform, Schedule, UserSettings, Work } from "../core/types.ts";
import type { ChapterInfo } from "../connectors/types.ts";

export type StorageKind = "video" | "audio" | "image" | "page" | "upload" | "partial" | "other";

export interface StoredObject {
  id: string;
  user_id: string;
  job_id: string | null;
  bucket: string;
  path: string;
  kind: StorageKind;
  size_bytes: number;
  content_type: string | null;
  expires_at: string | null;
  deleted_at: string | null;
  completed_at: string | null;
  first_download_at: string | null;
}

export interface TransitionOptions {
  error?: string;
  retryInSeconds?: number | null;
  countAttempt?: boolean;
  waitingReason?: string;
  keepLock?: boolean;
}

export interface NewJob {
  user_id: string;
  work_id: string;
  schedule_id: string | null;
  summary_format: string;
  target_duration_seconds: number;
  platforms: Platform[];
  priority: number;
  slot_at: string;
  run_at: string;
  dedupe_key: string;
  cost_limit_usd: number;
  max_attempts: number;
}

export interface ScriptRow {
  user_id: string;
  job_id: string;
  work_id: string;
  chapter_id: string | null;
  title: string;
  description: string;
  hashtags: string[];
  segments: unknown;
  full_text: string;
  word_count: number;
  model: string;
  validation: unknown;
}

export interface VideoRow {
  user_id: string;
  job_id: string;
  work_id: string;
  title: string;
  duration_seconds: number;
  width: number;
  height: number;
  size_bytes: number;
  render_provider: string;
  render_ref?: string | null;
  validation: unknown;
  storage_object_id: string | null;
  rendered_at: string;
  validated_at?: string | null;
}

export interface Publication {
  id: string;
  user_id: string;
  job_id: string;
  video_id: string | null;
  platform: Platform;
  status: "pending" | "uploading" | "processing" | "scheduled" | "published" | "failed" | "cancelled";
  title: string | null;
  description: string | null;
  privacy: string | null;
  publish_at: string | null;
  remote_id: string | null;
  remote_url: string | null;
  upload_session_url: string | null;
  attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
  confirmed_at: string | null;
}

export interface Integration {
  id: string;
  user_id: string;
  provider: "youtube" | "tiktok" | "gemini" | "shotstack";
  status: "connected" | "expired" | "error" | "disconnected";
  account_id: string | null;
  account_name: string | null;
  scopes: string[];
  token_expires_at: string | null;
  metadata: Record<string, unknown>;
  last_error: string | null;
}

export interface UsageRow {
  user_id: string;
  job_id: string | null;
  provider: string;
  kind: string;
  model: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  units?: number | null;
  unit_type?: string | null;
  cost_usd: number;
  failed?: boolean;
}

export interface Allowance {
  allowed: boolean;
  reason?: string;
  paused?: boolean;
  job_limit?: boolean;
}

export interface CleanupCandidate {
  id: string;
  user_id: string;
  bucket: string;
  path: string;
  kind: StorageKind;
  size_bytes: number;
}

export interface LogEntry {
  user_id?: string | null;
  job_id?: string | null;
  level: "debug" | "info" | "warn" | "error";
  event: string;
  message?: string;
  data?: unknown;
}

export interface Repo {
  // queue
  promoteDueJobs(): Promise<number>;
  claimJobs(executor: Executor, worker: string, limit: number, leaseSeconds: number): Promise<Job[]>;
  renewLease(jobId: string, worker: string, seconds: number): Promise<boolean>;
  releaseJob(jobId: string, worker: string): Promise<void>;
  transition(jobId: string, worker: string | null, to: JobState, opts?: TransitionOptions): Promise<Job>;
  getJob(id: string): Promise<Job | null>;
  updateJob(id: string, patch: Partial<Pick<Job, "chapter_id" | "content_key" | "summary_format" | "run_at">> & { render_requested_at?: string }): Promise<void>;
  insertJobs(rows: NewJob[]): Promise<number>;
  readyJobsDueForPublishing(limit: number): Promise<Job[]>;
  // checkpoints
  getStep(jobId: string, step: string): Promise<{ status: string; output: unknown } | null>;
  saveStep(jobId: string, step: string, status: "running" | "succeeded" | "failed", output?: unknown, error?: string): Promise<void>;
  // works, chapters, calendar
  getWork(id: string): Promise<Work | null>;
  updateWork(id: string, patch: Partial<Work> & { last_checked_at?: string; next_check_at?: string }): Promise<void>;
  worksDueForCheck(limit: number): Promise<Work[]>;
  getSettings(userId: string): Promise<UserSettings>;
  activeSchedules(): Promise<Schedule[]>;
  markMaterialized(scheduleId: string, until: string): Promise<void>;
  upsertChapters(userId: string, workId: string, chapters: ChapterInfo[]): Promise<number>;
  nextChapter(workId: string, format: string): Promise<Chapter | null>;
  getChapter(id: string): Promise<Chapter | null>;
  updateChapter(id: string, patch: Partial<Chapter> & { analysis?: unknown; processed_at?: string; page_count?: number }): Promise<void>;
  processedChapters(workId: string, limit: number): Promise<Chapter[]>;
  // narrative memory
  getMemory(workId: string): Promise<MemoryEntry[]>;
  upsertMemory(userId: string, workId: string, entries: MemoryEntry[]): Promise<void>;
  // outputs
  saveScript(row: ScriptRow): Promise<string>;
  getScript(jobId: string): Promise<(ScriptRow & { id: string }) | null>;
  saveNarration(row: { user_id: string; job_id: string; script_id: string | null; model: string; voice: string; duration_seconds: number; storage_object_id: string | null }): Promise<void>;
  saveVideo(row: VideoRow): Promise<string>;
  getVideo(jobId: string): Promise<(VideoRow & { id: string; file_deleted_at: string | null }) | null>;
  // storage registry
  registerObject(userId: string, jobId: string | null, path: string, kind: StorageKind, size: number, contentType: string | null, completed?: boolean): Promise<StoredObject>;
  objectsForJob(jobId: string, kinds?: StorageKind[]): Promise<StoredObject[]>;
  objectsByPrefix(userId: string, prefix: string): Promise<StoredObject[]>;
  attachObjectsToJob(ids: string[], jobId: string): Promise<void>;
  // publications & integrations
  publications(jobId: string): Promise<Publication[]>;
  createPublications(rows: Omit<Publication, "id" | "status" | "attempts" | "next_attempt_at" | "last_error" | "confirmed_at" | "remote_id" | "remote_url" | "upload_session_url">[]): Promise<void>;
  updatePublication(id: string, patch: Partial<Publication> & { response?: unknown }): Promise<void>;
  getIntegration(userId: string, provider: Integration["provider"]): Promise<Integration | null>;
  upsertIntegration(row: Omit<Integration, "id" | "last_error"> & { last_error?: string | null }): Promise<void>;
  updateIntegration(userId: string, provider: Integration["provider"], patch: Partial<Integration>): Promise<void>;
  getSecret(userId: string, name: string): Promise<Sealed | null>;
  putSecret(userId: string, name: string, sealed: Sealed): Promise<void>;
  deleteSecret(userId: string, name: string): Promise<void>;
  // usage & limits
  recordUsage(u: UsageRow): Promise<void>;
  checkAllowance(userId: string, jobId: string | null, kind: string, estimatedUsd: number): Promise<Allowance>;
  // observability
  log(e: LogEntry): Promise<void>;
  raiseAlert(userId: string | null, kind: string, level: "info" | "warning" | "critical", message: string, dedupeKey: string, data?: unknown): Promise<void>;
  // cleanup
  cleanupCandidates(limit: number): Promise<CleanupCandidate[]>;
  cleanupBlockedCount(): Promise<number>;
  markObjectDeleted(id: string): Promise<void>;
  markDeleteFailed(id: string, error: string): Promise<number>;
  purgeOldLogs(): Promise<number>;
  refreshStorageAlerts(): Promise<number>;
  startCleanupRun(): Promise<string>;
  finishCleanupRun(id: string, stats: { scanned: number; deleted: number; skipped: number; failed: number; bytes_freed: number; logs_purged: number; notes?: unknown }): Promise<void>;
  storageObjectExists(bucket: string, path: string): Promise<boolean>;
  // user actions (validated server-side)
  requestJobAction(userId: string, jobId: string, action: "retry" | "cancel" | "run_now"): Promise<Job>;
  registerDownload(userId: string, objectId: string): Promise<StoredObject>;
  resumeAutomation(userId: string): Promise<void>;
  findObject(userId: string, objectId: string): Promise<StoredObject | null>;
  upsertChapterForUpload(userId: string, workId: string, chapterKey: string, number: number | null): Promise<string>;
  putOAuthState(row: { state: string; user_id: string; provider: string; code_verifier: string; redirect_to: string | null }): Promise<void>;
  takeOAuthState(state: string): Promise<{ user_id: string; provider: string; code_verifier: string; redirect_to: string | null } | null>;
}

/** Private media storage (Supabase Storage bucket "media" in production). */
export interface Blobs {
  put(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(path: string): Promise<Uint8Array>;
  signedUrl(path: string, ttlSeconds: number, downloadName?: string): Promise<string>;
  remove(paths: string[]): Promise<void>;
  signedUploadUrl(path: string): Promise<{ url: string; token: string }>;
}
