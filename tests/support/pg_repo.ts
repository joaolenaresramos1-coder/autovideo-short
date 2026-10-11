// Test implementation of Repo/Blobs: real PostgreSQL with the real
// migrations (same SQL functions as production) and a local-disk bucket that
// also maintains storage.objects like Supabase Storage does.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type pg from "pg";
import type { Sealed } from "../../supabase/functions/_shared/core/crypto.ts";
import type { MemoryEntry } from "../../supabase/functions/_shared/core/memory.ts";
import type { Executor, JobState } from "../../supabase/functions/_shared/core/states.ts";
import type { Chapter, Job, Schedule, UserSettings, Work } from "../../supabase/functions/_shared/core/types.ts";
import type { ChapterInfo } from "../../supabase/functions/_shared/connectors/types.ts";
import type {
  Allowance, Blobs, CleanupCandidate, Integration, LogEntry, NewJob, Publication, Repo, ScriptRow, StorageKind,
  StoredObject, TransitionOptions, UsageRow, VideoRow,
} from "../../supabase/functions/_shared/adapters/repo.ts";

const NUMERIC_JOB = ["cost_limit_usd", "cost_spent_usd"];

/** node-postgres returns arrays of enums as "{a,b}" text; PostgREST returns JSON arrays. */
function pgArray(v: unknown): unknown {
  if (typeof v !== "string" || !v.startsWith("{")) return v;
  const inner = v.slice(1, -1);
  return inner ? inner.split(",").map((x) => x.replace(/^"|"$/g, "")) : [];
}
function fixArrays<T extends Record<string, unknown>>(r: T): T {
  for (const k of ["platforms", "target_platforms", "days_of_week"]) {
    if (k in r) (r as Record<string, unknown>)[k] = pgArray(r[k]);
  }
  if (Array.isArray(r.days_of_week)) (r as Record<string, unknown>).days_of_week = (r.days_of_week as unknown[]).map(Number);
  return r;
}

function fixJob(j: Record<string, unknown>): Job {
  fixArrays(j);
  for (const k of NUMERIC_JOB) if (j[k] !== undefined && j[k] !== null) j[k] = Number(j[k]);
  for (const k of ["slot_at", "run_at", "next_attempt_at", "locked_until"]) {
    if (j[k] instanceof Date) j[k] = (j[k] as Date).toISOString();
  }
  return j as unknown as Job;
}
function iso<T extends Record<string, unknown>>(r: T): T {
  for (const [k, v] of Object.entries(r)) if (v instanceof Date) (r as Record<string, unknown>)[k] = v.toISOString();
  return r;
}

function insertSql(table: string, row: Record<string, unknown>, conflict = "") {
  const keys = Object.keys(row);
  return {
    text: `insert into ${table} (${keys.join(",")}) values (${keys.map((_, i) => `$${i + 1}`).join(",")}) ${conflict}`,
    values: keys.map((k) => (row[k] !== null && typeof row[k] === "object" && !(row[k] instanceof Date) && !Array.isArray(row[k]) ? JSON.stringify(row[k]) : Array.isArray(row[k]) && k === "segments" ? JSON.stringify(row[k]) : row[k])),
  };
}

function updateSql(table: string, patch: Record<string, unknown>, where: string, whereValues: unknown[]) {
  const keys = Object.keys(patch);
  const values = keys.map((k) => {
    const v = patch[k];
    return v !== null && typeof v === "object" && !(v instanceof Date) && !Array.isArray(v) ? JSON.stringify(v) : v;
  });
  const shifted = where.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + keys.length}`);
  return { text: `update ${table} set ${keys.map((k, i) => `${k} = $${i + 1}`).join(", ")} where ${shifted}`, values: [...values, ...whereValues] };
}

export class PgRepo implements Repo {
  db: pg.Client;
  constructor(db: pg.Client) {
    this.db = db;
  }
  private async q<T = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<T[]> {
    return (await this.db.query(text, values)).rows as T[];
  }

  async promoteDueJobs() {
    return (await this.q<{ n: number }>("select promote_due_jobs() as n"))[0].n;
  }
  async claimJobs(executor: Executor, worker: string, limit: number, lease: number) {
    return (await this.q("select * from claim_jobs($1,$2,$3,$4)", [executor, worker, limit, lease])).map(fixJob);
  }
  async renewLease(jobId: string, worker: string, seconds: number) {
    return (await this.q<{ ok: boolean }>("select renew_lease($1,$2,$3) as ok", [jobId, worker, seconds]))[0].ok;
  }
  async releaseJob(jobId: string, worker: string) {
    await this.q("select release_job($1,$2)", [jobId, worker]);
  }
  async transition(jobId: string, worker: string | null, to: JobState, o: TransitionOptions = {}) {
    const r = await this.q("select * from transition_job($1,$2,$3,$4,$5,$6,$7,$8)", [
      jobId, worker, to, o.error ?? null, o.retryInSeconds ?? null, o.countAttempt ?? false, o.waitingReason ?? null, o.keepLock ?? false,
    ]);
    return fixJob(r[0]);
  }
  async getJob(id: string) {
    const r = await this.q("select * from jobs where id = $1", [id]);
    return r[0] ? fixJob(r[0]) : null;
  }
  async updateJob(id: string, patch: Record<string, unknown>) {
    if (Object.keys(patch).length === 0) return;
    const s = updateSql("jobs", patch, "id = $1", [id]);
    await this.db.query(s.text, s.values);
  }
  async insertJobs(rows: NewJob[]) {
    let n = 0;
    for (const r of rows) {
      const s = insertSql("jobs", r as unknown as Record<string, unknown>, "on conflict (dedupe_key) do nothing");
      n += (await this.db.query(s.text, s.values)).rowCount ?? 0;
    }
    return n;
  }
  async readyJobsDueForPublishing(limit: number) {
    return (await this.q(
      "select * from jobs where state = 'ready_to_publish' and platforms <> '{}' and slot_at <= now() + interval '6 hours' order by slot_at limit $1",
      [limit],
    )).map(fixJob);
  }

  async getStep(jobId: string, step: string) {
    return (await this.q<{ status: string; output: unknown }>("select status, output from job_steps where job_id = $1 and step = $2", [jobId, step]))[0] ?? null;
  }
  async saveStep(jobId: string, step: string, status: string, output?: unknown, error?: string) {
    await this.q("select save_step($1,$2,$3,$4,$5)", [jobId, step, status, output === undefined ? null : JSON.stringify(output), error ?? null]);
  }

  async getWork(id: string) {
    const r = (await this.q("select * from works where id = $1", [id]))[0];
    return r ? (fixArrays(r) as unknown as Work) : null;
  }
  async updateWork(id: string, patch: Record<string, unknown>) {
    const s = updateSql("works", patch, "id = $1", [id]);
    await this.db.query(s.text, s.values);
  }
  async worksDueForCheck(limit: number) {
    return (await this.q("select * from works where status in ('active','error') and next_check_at <= now() order by next_check_at limit $1", [limit])).map(fixArrays) as unknown as Work[];
  }
  async getSettings(userId: string) {
    const r = (await this.q("select * from user_settings where user_id = $1", [userId]))[0];
    for (const k of ["daily_cost_limit_usd", "monthly_cost_limit_usd"]) r[k] = Number(r[k]);
    return r as unknown as UserSettings;
  }
  async activeSchedules() {
    return (await this.q("select *, to_char(time_of_day, 'HH24:MI') as time_of_day, starts_on::text, ends_on::text from schedules where active")).map((r) => {
      r.cost_limit_usd = Number(r.cost_limit_usd);
      return fixArrays(iso(r));
    }) as unknown as Schedule[];
  }
  async markMaterialized(id: string, until: string) {
    await this.q("update schedules set materialized_until = $2 where id = $1", [id, until]);
  }
  async upsertChapters(userId: string, workId: string, chapters: ChapterInfo[]) {
    let n = 0;
    for (const c of chapters) {
      n += (await this.db.query(
        `insert into chapters (user_id, work_id, chapter_key, number, title, source_chapter_id, source_url, source_published_at, page_count)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (work_id, chapter_key) do nothing`,
        [userId, workId, c.key, c.number, c.title, c.sourceId, c.url, c.publishedAt, c.pageCount ?? null],
      )).rowCount ?? 0;
    }
    return n;
  }
  async nextChapter(workId: string, format: string) {
    const r = await this.q("select * from next_chapter_for($1, $2)", [workId, format]);
    return r[0]?.id ? (r[0] as unknown as Chapter) : null;
  }
  async getChapter(id: string) {
    const r = (await this.q("select * from chapters where id = $1", [id]))[0];
    if (r && r.number !== null) r.number = Number(r.number);
    return (r as unknown as Chapter) ?? null;
  }
  async updateChapter(id: string, patch: Record<string, unknown>) {
    const s = updateSql("chapters", patch, "id = $1", [id]);
    await this.db.query(s.text, s.values);
  }
  async processedChapters(workId: string, limit: number) {
    return (await this.q("select * from chapters where work_id = $1 and status = 'processed' order by number desc nulls last limit $2", [workId, limit])) as unknown as Chapter[];
  }
  async getMemory(workId: string) {
    return (await this.q("select * from memory_entries where work_id = $1", [workId])) as unknown as MemoryEntry[];
  }
  async upsertMemory(userId: string, workId: string, entries: MemoryEntry[]) {
    for (const e of entries) {
      await this.q(
        `insert into memory_entries (user_id, work_id, kind, name, content, certainty, first_chapter_key, updated_chapter_key, superseded)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         on conflict (work_id, kind, name) do update set content = excluded.content, certainty = excluded.certainty,
           updated_chapter_key = excluded.updated_chapter_key, superseded = excluded.superseded`,
        [userId, workId, e.kind, e.name, e.content, e.certainty, e.first_chapter_key ?? null, e.updated_chapter_key ?? null, e.superseded ?? false],
      );
    }
  }
  async saveScript(row: ScriptRow) {
    const r = await this.q<{ id: string }>(
      `insert into scripts (user_id, job_id, work_id, chapter_id, title, description, hashtags, segments, full_text, word_count, model, validation)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       on conflict (job_id) do update set title = excluded.title, description = excluded.description, hashtags = excluded.hashtags,
         segments = excluded.segments, full_text = excluded.full_text, word_count = excluded.word_count, validation = excluded.validation,
         version = scripts.version + 1
       returning id`,
      [row.user_id, row.job_id, row.work_id, row.chapter_id, row.title, row.description, row.hashtags, JSON.stringify(row.segments), row.full_text, row.word_count, row.model, JSON.stringify(row.validation)],
    );
    return r[0].id;
  }
  async getScript(jobId: string) {
    return ((await this.q("select * from scripts where job_id = $1", [jobId]))[0] as unknown as ScriptRow & { id: string }) ?? null;
  }
  async saveNarration(row: Record<string, unknown>) {
    const s = insertSql("narrations", row, "on conflict (job_id) do update set duration_seconds = excluded.duration_seconds, storage_object_id = excluded.storage_object_id");
    await this.db.query(s.text, s.values);
  }
  async saveVideo(row: VideoRow) {
    const r = row as unknown as Record<string, unknown>;
    const keys = Object.keys(r);
    const res = await this.q<{ id: string }>(
      `insert into videos (${keys.join(",")}) values (${keys.map((_, i) => `$${i + 1}`).join(",")})
       on conflict (job_id) do update set ${keys.filter((k) => k !== "job_id").map((k) => `${k} = excluded.${k}`).join(", ")} returning id`,
      keys.map((k) => (k === "validation" ? JSON.stringify(r[k]) : r[k])),
    );
    return res[0].id;
  }
  async getVideo(jobId: string) {
    const r = (await this.q("select * from videos where job_id = $1", [jobId]))[0];
    return (r as unknown as VideoRow & { id: string; file_deleted_at: string | null }) ?? null;
  }
  async registerObject(userId: string, jobId: string | null, path: string, kind: StorageKind, size: number, contentType: string | null, completed = true) {
    return iso((await this.q("select * from register_object($1,$2,'media',$3,$4,$5,$6,$7)", [userId, jobId, path, kind, size, contentType, completed]))[0]) as unknown as StoredObject;
  }
  async objectsForJob(jobId: string, kinds?: StorageKind[]) {
    return (await this.q(
      `select * from storage_objects where job_id = $1 and deleted_at is null ${kinds ? "and kind = any($2::storage_kind[])" : ""} order by path`,
      kinds ? [jobId, kinds] : [jobId],
    )) as unknown as StoredObject[];
  }
  async objectsByPrefix(userId: string, prefix: string) {
    return (await this.q("select * from storage_objects where user_id = $1 and path like $2 and deleted_at is null order by path", [userId, `${prefix}%`])) as unknown as StoredObject[];
  }
  async attachObjectsToJob(ids: string[], jobId: string) {
    if (ids.length) await this.q("update storage_objects set job_id = $2 where id = any($1::uuid[])", [ids, jobId]);
  }
  async publications(jobId: string) {
    return (await this.q("select * from publications where job_id = $1 order by platform", [jobId])).map((r) => iso(r)) as unknown as Publication[];
  }
  async createPublications(rows: Record<string, unknown>[]) {
    for (const r of rows) {
      const s = insertSql("publications", r, "on conflict (job_id, platform) do nothing");
      await this.db.query(s.text, s.values);
    }
  }
  async updatePublication(id: string, patch: Record<string, unknown>) {
    const s = updateSql("publications", patch, "id = $1", [id]);
    await this.db.query(s.text, s.values);
  }
  async getIntegration(userId: string, provider: string) {
    return ((await this.q("select * from integrations where user_id = $1 and provider = $2", [userId, provider]))[0] as unknown as Integration) ?? null;
  }
  async upsertIntegration(row: Record<string, unknown>) {
    const keys = Object.keys(row);
    await this.q(
      `insert into integrations (${keys.join(",")}) values (${keys.map((_, i) => `$${i + 1}`).join(",")})
       on conflict (user_id, provider) do update set ${keys.filter((k) => !["user_id", "provider"].includes(k)).map((k) => `${k} = excluded.${k}`).join(", ")}`,
      keys.map((k) => (k === "metadata" ? JSON.stringify(row[k]) : row[k])),
    );
  }
  async updateIntegration(userId: string, provider: string, patch: Record<string, unknown>) {
    const s = updateSql("integrations", patch, "user_id = $1 and provider = $2", [userId, provider]);
    await this.db.query(s.text, s.values);
  }
  async getSecret(userId: string, name: string) {
    return ((await this.q("select ciphertext, iv from secrets where user_id = $1 and name = $2", [userId, name]))[0] as unknown as Sealed) ?? null;
  }
  async putSecret(userId: string, name: string, s: Sealed) {
    await this.q(
      "insert into secrets (user_id, name, ciphertext, iv) values ($1,$2,$3,$4) on conflict (user_id, name) do update set ciphertext = excluded.ciphertext, iv = excluded.iv, updated_at = now()",
      [userId, name, s.ciphertext, s.iv],
    );
  }
  async deleteSecret(userId: string, name: string) {
    await this.q("delete from secrets where user_id = $1 and name = $2", [userId, name]);
  }
  async recordUsage(u: UsageRow) {
    await this.q("select record_usage($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)", [
      u.user_id, u.job_id, u.provider, u.kind, u.model, u.input_tokens ?? null, u.output_tokens ?? null, u.units ?? null, u.unit_type ?? null, u.cost_usd, u.failed ?? false,
    ]);
  }
  async checkAllowance(userId: string, jobId: string | null, kind: string, est: number) {
    return (await this.q<{ a: Allowance }>("select check_cost_allowance($1,$2,$3,$4) as a", [userId, jobId, kind, est]))[0].a;
  }
  async log(e: LogEntry) {
    await this.q("insert into job_logs (user_id, job_id, level, event, message, data) values ($1,$2,$3,$4,$5,$6)", [
      e.user_id ?? null, e.job_id ?? null, e.level, e.event, e.message ?? null, e.data === undefined ? null : JSON.stringify(e.data),
    ]);
  }
  async raiseAlert(userId: string | null, kind: string, level: string, message: string, dedupeKey: string, data?: unknown) {
    await this.q("insert into alerts (user_id, kind, level, message, dedupe_key, data) values ($1,$2,$3,$4,$5,$6) on conflict do nothing", [
      userId, kind, level, message, dedupeKey, data === undefined ? null : JSON.stringify(data),
    ]);
  }
  async cleanupCandidates(limit: number) {
    return (await this.q("select * from cleanup_candidates($1)", [limit])) as unknown as CleanupCandidate[];
  }
  async cleanupBlockedCount() {
    return (await this.q<{ n: number }>("select cleanup_blocked_count() as n"))[0].n;
  }
  async markObjectDeleted(id: string) {
    await this.q("select mark_object_deleted($1)", [id]);
  }
  async markDeleteFailed(id: string, error: string) {
    return (await this.q<{ n: number }>("select mark_object_delete_failed($1,$2) as n", [id, error]))[0].n;
  }
  async purgeOldLogs() {
    return (await this.q<{ n: number }>("select purge_old_logs() as n"))[0].n;
  }
  async refreshStorageAlerts() {
    return (await this.q<{ n: number }>("select refresh_storage_alerts() as n"))[0].n;
  }
  async startCleanupRun() {
    return (await this.q<{ id: string }>("insert into cleanup_runs default values returning id"))[0].id;
  }
  async finishCleanupRun(id: string, stats: Record<string, unknown>) {
    const s = updateSql("cleanup_runs", { ...stats, finished_at: new Date().toISOString() }, "id = $1", [id]);
    await this.db.query(s.text, s.values);
  }
  async storageObjectExists(bucket: string, path: string) {
    return (await this.q<{ e: boolean }>("select storage_object_exists($1,$2) as e", [bucket, path]))[0].e;
  }
  async requestJobAction(userId: string, jobId: string, action: string) {
    return fixJob((await this.q("select * from request_job_action($1,$2,$3)", [userId, jobId, action]))[0]);
  }
  async registerDownload(userId: string, objectId: string) {
    return iso((await this.q("select * from register_download($1,$2)", [userId, objectId]))[0]) as unknown as StoredObject;
  }
  async resumeAutomation(userId: string) {
    await this.q("select resume_automation($1)", [userId]);
  }
  async findObject(userId: string, objectId: string) {
    return ((await this.q("select * from storage_objects where id = $1 and user_id = $2", [objectId, userId]))[0] as unknown as StoredObject) ?? null;
  }
  async upsertChapterForUpload(userId: string, workId: string, key: string, number: number | null) {
    return (await this.q<{ id: string }>(
      "insert into chapters (user_id, work_id, chapter_key, number) values ($1,$2,$3,$4) on conflict (work_id, chapter_key) do update set number = coalesce(chapters.number, excluded.number) returning id",
      [userId, workId, key, number],
    ))[0].id;
  }
  async createWork(row: Record<string, unknown>) {
    const s = insertSql("works", { status: "active", ...row }, "returning id");
    return (await this.db.query(s.text, s.values)).rows[0].id as string;
  }
  async upsertChapter(userId: string, workId: string, key: string, o: { number: number | null; title?: string | null; sourceUrl?: string | null }) {
    return (await this.q<{ id: string }>(
      `insert into chapters (user_id, work_id, chapter_key, number, title, source_url) values ($1,$2,$3,$4,$5,$6)
       on conflict (work_id, chapter_key) do update set source_url = coalesce(excluded.source_url, chapters.source_url),
         title = coalesce(excluded.title, chapters.title) returning id`,
      [userId, workId, key, o.number, o.title ?? null, o.sourceUrl ?? null],
    ))[0].id;
  }
  async createJob(row: NewJob & { state: string; chapter_id: string | null; content_key: string | null }) {
    const s = insertSql("jobs", row as unknown as Record<string, unknown>, "returning id");
    return (await this.db.query(s.text, s.values)).rows[0].id as string;
  }
  async putOAuthState(row: Record<string, unknown>) {
    const s = insertSql("oauth_states", row);
    await this.db.query(s.text, s.values);
  }
  async takeOAuthState(state: string) {
    return (await this.q<{ user_id: string; provider: string; code_verifier: string; redirect_to: string | null }>(
      "delete from oauth_states where state = $1 and expires_at > now() returning user_id, provider, code_verifier, redirect_to",
      [state],
    ))[0] ?? null;
  }
}

/** Disk-backed bucket that keeps storage.objects in sync (like Supabase Storage). */
export class FsBlobs implements Blobs {
  root: string;
  db: pg.Client;
  failNextGet: Set<string> = new Set();
  constructor(root: string, db: pg.Client) {
    this.root = root;
    this.db = db;
  }
  async put(path: string, bytes: Uint8Array, contentType: string) {
    const f = join(this.root, path);
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, bytes);
    await this.db.query("delete from storage.objects where bucket_id = 'media' and name = $1", [path]);
    await this.db.query("insert into storage.objects (bucket_id, name, metadata) values ('media', $1, $2)", [
      path, JSON.stringify({ size: bytes.length, mimetype: contentType }),
    ]);
  }
  async get(path: string) {
    if (this.failNextGet.has(path)) {
      this.failNextGet.delete(path);
      throw new Error(`falha simulada ao ler ${path}`);
    }
    return new Uint8Array(await readFile(join(this.root, path)));
  }
  async signedUrl(path: string, ttl: number) {
    return `file://${join(this.root, path)}?ttl=${ttl}`;
  }
  async remove(paths: string[]) {
    for (const p of paths) {
      await rm(join(this.root, p), { force: true });
      await this.db.query("delete from storage.objects where bucket_id = 'media' and name = $1", [p]);
    }
  }
  async signedUploadUrl(path: string) {
    return { url: `upload://${path}`, token: "t" };
  }
  exists(path: string) {
    return existsSync(join(this.root, path));
  }
}
