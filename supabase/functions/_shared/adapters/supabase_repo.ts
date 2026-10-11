// Repo/Blobs over supabase-js with the service role key (server side only).

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { StepError } from "../core/backoff.ts";
import type { Sealed } from "../core/crypto.ts";
import type { MemoryEntry } from "../core/memory.ts";
import type { Executor, JobState } from "../core/states.ts";
import type { Chapter, Job, Schedule, UserSettings, Work } from "../core/types.ts";
import type { ChapterInfo } from "../connectors/types.ts";
import type {
  Allowance, Blobs, CleanupCandidate, Integration, LogEntry, NewJob, Publication, Repo, ScriptRow,
  StorageKind, StoredObject, TransitionOptions, UsageRow, VideoRow,
} from "./repo.ts";

export const BUCKET = "media";

export function serviceClient(url: string, serviceKey: string): SupabaseClient {
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { "x-client-info": "autovideo-server" } },
  });
}

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };

function must<T>(r: Res<T>, what: string): T {
  if (r.error) throw new StepError(`Banco (${what}): ${r.error.message}`, "retryable");
  return r.data as T;
}

export class SupabaseRepo implements Repo {
  db: SupabaseClient;
  constructor(db: SupabaseClient) {
    this.db = db;
  }

  private async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const r = await this.db.rpc(fn, args);
    if (r.error) {
      // State conflicts are not transient: surface them as permanent errors.
      const kind = ["22023", "55000", "55P03", "P0002"].includes(r.error.code ?? "") ? "permanent" : "retryable";
      throw new StepError(`Banco (${fn}): ${r.error.message}`, kind);
    }
    return r.data as T;
  }

  promoteDueJobs() {
    return this.rpc<number>("promote_due_jobs", {});
  }
  claimJobs(executor: Executor, worker: string, limit: number, leaseSeconds: number) {
    return this.rpc<Job[]>("claim_jobs", { p_executor: executor, p_worker: worker, p_limit: limit, p_lease_seconds: leaseSeconds });
  }
  renewLease(jobId: string, worker: string, seconds: number) {
    return this.rpc<boolean>("renew_lease", { p_job: jobId, p_worker: worker, p_lease_seconds: seconds });
  }
  async releaseJob(jobId: string, worker: string) {
    await this.rpc("release_job", { p_job: jobId, p_worker: worker });
  }
  transition(jobId: string, worker: string | null, to: JobState, o: TransitionOptions = {}) {
    return this.rpc<Job>("transition_job", {
      p_job: jobId,
      p_worker: worker,
      p_to: to,
      p_error: o.error ?? null,
      p_retry_in_seconds: o.retryInSeconds ?? null,
      p_count_attempt: o.countAttempt ?? false,
      p_waiting_reason: o.waitingReason ?? null,
      p_keep_lock: o.keepLock ?? false,
    });
  }
  async getJob(id: string) {
    return must(await this.db.from("jobs").select("*").eq("id", id).maybeSingle(), "jobs") as Job | null;
  }
  async updateJob(id: string, patch: Record<string, unknown>) {
    must(await this.db.from("jobs").update(patch).eq("id", id), "jobs");
  }
  async insertJobs(rows: NewJob[]) {
    if (rows.length === 0) return 0;
    const r = must(
      await this.db.from("jobs").upsert(rows, { onConflict: "dedupe_key", ignoreDuplicates: true }).select("id"),
      "jobs",
    ) as { id: string }[];
    return r.length;
  }
  async readyJobsDueForPublishing(limit: number) {
    return must(
      await this.db.from("jobs").select("*").eq("state", "ready_to_publish").neq("platforms", "{}")
        .lte("slot_at", new Date(Date.now() + 6 * 3600_000).toISOString()).order("slot_at").limit(limit),
      "jobs",
    ) as Job[];
  }

  async getStep(jobId: string, step: string) {
    return must(await this.db.from("job_steps").select("status, output").eq("job_id", jobId).eq("step", step).maybeSingle(), "job_steps") as
      | { status: string; output: unknown }
      | null;
  }
  async saveStep(jobId: string, step: string, status: string, output?: unknown, error?: string) {
    await this.rpc("save_step", { p_job: jobId, p_step: step, p_status: status, p_output: output ?? null, p_error: error ?? null });
  }

  async getWork(id: string) {
    return must(await this.db.from("works").select("*").eq("id", id).maybeSingle(), "works") as Work | null;
  }
  async updateWork(id: string, patch: Record<string, unknown>) {
    must(await this.db.from("works").update(patch).eq("id", id), "works");
  }
  async worksDueForCheck(limit: number) {
    return must(
      await this.db.from("works").select("*").in("status", ["active", "error"]).lte("next_check_at", new Date().toISOString())
        .order("next_check_at").limit(limit),
      "works",
    ) as Work[];
  }
  async getSettings(userId: string) {
    const s = must(await this.db.from("user_settings").select("*").eq("user_id", userId).maybeSingle(), "user_settings");
    if (s) return s as UserSettings;
    return must(await this.db.from("user_settings").insert({ user_id: userId }).select("*").single(), "user_settings") as UserSettings;
  }
  async activeSchedules() {
    return must(await this.db.from("schedules").select("*").eq("active", true), "schedules") as Schedule[];
  }
  async markMaterialized(scheduleId: string, until: string) {
    must(await this.db.from("schedules").update({ materialized_until: until }).eq("id", scheduleId), "schedules");
  }
  async upsertChapters(userId: string, workId: string, chapters: ChapterInfo[]) {
    if (chapters.length === 0) return 0;
    const rows = chapters.map((c) => ({
      user_id: userId,
      work_id: workId,
      chapter_key: c.key,
      number: c.number,
      title: c.title,
      source_chapter_id: c.sourceId,
      source_url: c.url,
      source_published_at: c.publishedAt,
      page_count: c.pageCount ?? null,
    }));
    const r = must(
      await this.db.from("chapters").upsert(rows, { onConflict: "work_id,chapter_key", ignoreDuplicates: true }).select("id"),
      "chapters",
    ) as { id: string }[];
    return r.length;
  }
  async nextChapter(workId: string, format: string) {
    const r = await this.rpc<Chapter | null>("next_chapter_for", { p_work: workId, p_format: format });
    return r && (r as Chapter).id ? r : null;
  }
  async getChapter(id: string) {
    return must(await this.db.from("chapters").select("*").eq("id", id).maybeSingle(), "chapters") as Chapter | null;
  }
  async updateChapter(id: string, patch: Record<string, unknown>) {
    must(await this.db.from("chapters").update(patch).eq("id", id), "chapters");
  }
  async processedChapters(workId: string, limit: number) {
    return must(
      await this.db.from("chapters").select("*").eq("work_id", workId).eq("status", "processed")
        .order("number", { ascending: false, nullsFirst: false }).limit(limit),
      "chapters",
    ) as Chapter[];
  }

  async getMemory(workId: string) {
    return must(await this.db.from("memory_entries").select("*").eq("work_id", workId), "memory") as MemoryEntry[];
  }
  async upsertMemory(userId: string, workId: string, entries: MemoryEntry[]) {
    if (entries.length === 0) return;
    must(
      await this.db.from("memory_entries").upsert(
        entries.map((e) => ({ ...e, user_id: userId, work_id: workId })),
        { onConflict: "work_id,kind,name" },
      ),
      "memory",
    );
  }

  async saveScript(row: ScriptRow) {
    const r = must(await this.db.from("scripts").upsert(row, { onConflict: "job_id" }).select("id").single(), "scripts") as { id: string };
    return r.id;
  }
  async getScript(jobId: string) {
    return must(await this.db.from("scripts").select("*").eq("job_id", jobId).maybeSingle(), "scripts") as (ScriptRow & { id: string }) | null;
  }
  async saveNarration(row: Record<string, unknown>) {
    must(await this.db.from("narrations").upsert(row, { onConflict: "job_id" }), "narrations");
  }
  async saveVideo(row: VideoRow) {
    const r = must(await this.db.from("videos").upsert(row, { onConflict: "job_id" }).select("id").single(), "videos") as { id: string };
    return r.id;
  }
  async getVideo(jobId: string) {
    return must(await this.db.from("videos").select("*").eq("job_id", jobId).maybeSingle(), "videos") as
      | (VideoRow & { id: string; file_deleted_at: string | null })
      | null;
  }

  async registerObject(userId: string, jobId: string | null, path: string, kind: StorageKind, size: number, contentType: string | null, completed = true) {
    const r = await this.rpc<StoredObject | StoredObject[]>("register_object", {
      p_user: userId, p_job: jobId, p_bucket: BUCKET, p_path: path, p_kind: kind, p_size: size, p_content_type: contentType, p_completed: completed,
    });
    return Array.isArray(r) ? r[0] : r;
  }
  async objectsForJob(jobId: string, kinds?: StorageKind[]) {
    let q = this.db.from("storage_objects").select("*").eq("job_id", jobId).is("deleted_at", null);
    if (kinds) q = q.in("kind", kinds);
    return must(await q.order("path"), "storage_objects") as StoredObject[];
  }
  async objectsByPrefix(userId: string, prefix: string) {
    return must(
      await this.db.from("storage_objects").select("*").eq("user_id", userId).like("path", `${prefix}%`).is("deleted_at", null).order("path"),
      "storage_objects",
    ) as StoredObject[];
  }
  async attachObjectsToJob(ids: string[], jobId: string) {
    if (ids.length) must(await this.db.from("storage_objects").update({ job_id: jobId }).in("id", ids), "storage_objects");
  }

  async publications(jobId: string) {
    return must(await this.db.from("publications").select("*").eq("job_id", jobId), "publications") as Publication[];
  }
  async createPublications(rows: Record<string, unknown>[]) {
    if (rows.length) must(await this.db.from("publications").upsert(rows, { onConflict: "job_id,platform", ignoreDuplicates: true }), "publications");
  }
  async updatePublication(id: string, patch: Record<string, unknown>) {
    must(await this.db.from("publications").update(patch).eq("id", id), "publications");
  }
  async getIntegration(userId: string, provider: Integration["provider"]) {
    return must(await this.db.from("integrations").select("*").eq("user_id", userId).eq("provider", provider).maybeSingle(), "integrations") as Integration | null;
  }
  async upsertIntegration(row: Record<string, unknown>) {
    must(await this.db.from("integrations").upsert(row, { onConflict: "user_id,provider" }), "integrations");
  }
  async updateIntegration(userId: string, provider: string, patch: Record<string, unknown>) {
    must(await this.db.from("integrations").update(patch).eq("user_id", userId).eq("provider", provider), "integrations");
  }
  async getSecret(userId: string, name: string) {
    return must(await this.db.from("secrets").select("ciphertext, iv").eq("user_id", userId).eq("name", name).maybeSingle(), "secrets") as Sealed | null;
  }
  async putSecret(userId: string, name: string, sealed: Sealed) {
    must(await this.db.from("secrets").upsert({ user_id: userId, name, ...sealed, updated_at: new Date().toISOString() }), "secrets");
  }
  async deleteSecret(userId: string, name: string) {
    must(await this.db.from("secrets").delete().eq("user_id", userId).eq("name", name), "secrets");
  }

  async recordUsage(u: UsageRow) {
    await this.rpc("record_usage", {
      p_user: u.user_id, p_job: u.job_id, p_provider: u.provider, p_kind: u.kind, p_model: u.model,
      p_input_tokens: u.input_tokens ?? null, p_output_tokens: u.output_tokens ?? null, p_units: u.units ?? null,
      p_unit_type: u.unit_type ?? null, p_cost_usd: u.cost_usd, p_failed: u.failed ?? false,
    });
  }
  checkAllowance(userId: string, jobId: string | null, kind: string, estimatedUsd: number) {
    return this.rpc<Allowance>("check_cost_allowance", { p_user: userId, p_job: jobId, p_kind: kind, p_estimated_usd: estimatedUsd });
  }

  async log(e: LogEntry) {
    // Logging must never break the pipeline.
    await this.db.from("job_logs").insert({
      user_id: e.user_id ?? null, job_id: e.job_id ?? null, level: e.level, event: e.event, message: e.message?.slice(0, 2000) ?? null, data: e.data ?? null,
    });
  }
  async raiseAlert(userId: string | null, kind: string, level: string, message: string, dedupeKey: string, data?: unknown) {
    const r = await this.db.from("alerts").insert({ user_id: userId, kind, level, message, dedupe_key: dedupeKey, data: data ?? null });
    if (r.error && r.error.code !== "23505") throw new StepError(`Banco (alerts): ${r.error.message}`, "retryable");
  }

  async cleanupCandidates(limit: number) {
    return this.rpc<CleanupCandidate[]>("cleanup_candidates", { p_limit: limit });
  }
  cleanupBlockedCount() {
    return this.rpc<number>("cleanup_blocked_count", {});
  }
  async markObjectDeleted(id: string) {
    await this.rpc("mark_object_deleted", { p_object: id });
  }
  markDeleteFailed(id: string, error: string) {
    return this.rpc<number>("mark_object_delete_failed", { p_object: id, p_error: error });
  }
  purgeOldLogs() {
    return this.rpc<number>("purge_old_logs", {});
  }
  refreshStorageAlerts() {
    return this.rpc<number>("refresh_storage_alerts", {});
  }
  async startCleanupRun() {
    return (must(await this.db.from("cleanup_runs").insert({}).select("id").single(), "cleanup_runs") as { id: string }).id;
  }
  async finishCleanupRun(id: string, stats: Record<string, unknown>) {
    must(await this.db.from("cleanup_runs").update({ ...stats, finished_at: new Date().toISOString() }).eq("id", id), "cleanup_runs");
  }
  storageObjectExists(bucket: string, path: string) {
    return this.rpc<boolean>("storage_object_exists", { p_bucket: bucket, p_path: path });
  }

  requestJobAction(userId: string, jobId: string, action: string) {
    return this.rpc<Job>("request_job_action", { p_user: userId, p_job: jobId, p_action: action });
  }
  async registerDownload(userId: string, objectId: string) {
    const r = await this.rpc<StoredObject | StoredObject[]>("register_download", { p_user: userId, p_object: objectId });
    return Array.isArray(r) ? r[0] : r;
  }
  async resumeAutomation(userId: string) {
    await this.rpc("resume_automation", { p_user: userId });
  }
  async findObject(userId: string, objectId: string) {
    return must(await this.db.from("storage_objects").select("*").eq("id", objectId).eq("user_id", userId).maybeSingle(), "storage_objects") as StoredObject | null;
  }
  async upsertChapterForUpload(userId: string, workId: string, chapterKey: string, number: number | null) {
    const r = must(
      await this.db.from("chapters").upsert(
        { user_id: userId, work_id: workId, chapter_key: chapterKey, number, title: null },
        { onConflict: "work_id,chapter_key", ignoreDuplicates: false },
      ).select("id").single(),
      "chapters",
    ) as { id: string };
    return r.id;
  }
  async putOAuthState(row: Record<string, unknown>) {
    must(await this.db.from("oauth_states").insert(row), "oauth_states");
  }
  async takeOAuthState(state: string) {
    const r = must(
      await this.db.from("oauth_states").delete().eq("state", state).gt("expires_at", new Date().toISOString()).select("user_id, provider, code_verifier, redirect_to"),
      "oauth_states",
    ) as { user_id: string; provider: string; code_verifier: string; redirect_to: string | null }[];
    return r[0] ?? null;
  }
}

export class SupabaseBlobs implements Blobs {
  db: SupabaseClient;
  constructor(db: SupabaseClient) {
    this.db = db;
  }
  async put(path: string, bytes: Uint8Array, contentType: string) {
    const r = await this.db.storage.from(BUCKET).upload(path, bytes, { contentType, upsert: true });
    if (r.error) throw new StepError(`Storage upload ${path}: ${r.error.message}`, "retryable");
  }
  async get(path: string) {
    const r = await this.db.storage.from(BUCKET).download(path);
    if (r.error || !r.data) throw new StepError(`Storage download ${path}: ${r.error?.message ?? "vazio"}`, "retryable");
    return new Uint8Array(await r.data.arrayBuffer());
  }
  async signedUrl(path: string, ttlSeconds: number, downloadName?: string) {
    const r = await this.db.storage.from(BUCKET).createSignedUrl(path, ttlSeconds, downloadName ? { download: downloadName } : undefined);
    if (r.error || !r.data) throw new StepError(`Storage signed URL: ${r.error?.message}`, "retryable");
    return r.data.signedUrl;
  }
  async remove(paths: string[]) {
    if (paths.length === 0) return;
    const r = await this.db.storage.from(BUCKET).remove(paths);
    if (r.error) throw new StepError(`Storage remove: ${r.error.message}`, "retryable");
  }
  async signedUploadUrl(path: string) {
    const r = await this.db.storage.from(BUCKET).createSignedUploadUrl(path, { upsert: true });
    if (r.error || !r.data) throw new StepError(`Storage signed upload: ${r.error?.message}`, "retryable");
    return { url: r.data.signedUrl, token: r.data.token };
  }
}
