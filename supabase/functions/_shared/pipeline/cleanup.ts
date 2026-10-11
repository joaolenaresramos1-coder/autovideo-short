// Scheduled cleanup of expired files. Idempotent: running it twice never
// corrupts data, and only the binary is removed — the database rows
// (video, script, publication history) are preserved.

import { redact } from "../core/crypto.ts";
import type { Ctx } from "./context.ts";

export interface CleanupReport {
  scanned: number;
  deleted: number;
  skipped: number;
  failed: number;
  bytes_freed: number;
  logs_purged: number;
  errors: string[];
}

export async function runCleanup(ctx: Ctx, limit = 200): Promise<CleanupReport> {
  const runId = await ctx.repo.startCleanupRun();
  const report: CleanupReport = { scanned: 0, deleted: 0, skipped: 0, failed: 0, bytes_freed: 0, logs_purged: 0, errors: [] };
  try {
    // 1-2. expired objects that do not belong to a running/recovering job
    const candidates = await ctx.repo.cleanupCandidates(limit);
    report.scanned = candidates.length;
    report.skipped = await ctx.repo.cleanupBlockedCount();

    for (let i = 0; i < candidates.length; i += 50) {
      const batch = candidates.slice(i, i + 50);
      // 3. delete from storage
      try {
        await ctx.blobs.remove(batch.map((c) => c.path));
      } catch (e) {
        report.errors.push(redact((e as Error).message));
      }
      for (const c of batch) {
        try {
          // 4. confirm against Storage's own catalogue before touching the DB
          const still = await ctx.repo.storageObjectExists(c.bucket, c.path);
          if (still) throw new Error("objeto ainda presente após exclusão");
          // 5-6. mark as deleted (keeps history) and account freed space
          await ctx.repo.markObjectDeleted(c.id);
          report.deleted++;
          report.bytes_freed += Number(c.size_bytes);
        } catch (e) {
          // 7-8. retry with backoff; alert after repeated failures
          report.failed++;
          await ctx.repo.markDeleteFailed(c.id, redact((e as Error).message));
        }
      }
    }
    report.logs_purged = await ctx.repo.purgeOldLogs();
    await ctx.repo.refreshStorageAlerts();
  } finally {
    await ctx.repo.finishCleanupRun(runId, {
      scanned: report.scanned,
      deleted: report.deleted,
      skipped: report.skipped,
      failed: report.failed,
      bytes_freed: report.bytes_freed,
      logs_purged: report.logs_purged,
      notes: report.errors.length ? { errors: report.errors.slice(0, 10) } : null,
    });
  }
  return report;
}
