// Mirror of public.compute_video_expiry used for display only — the database
// is the source of truth for deadlines.

export interface RetentionPolicy {
  afterDownloadHours: number;
  maxHours: number;
  noDownloadHours: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  afterDownloadHours: 24,
  maxHours: 48,
  noDownloadHours: 48,
};

const H = 3600_000;

export function computeVideoExpiry(
  completedAt: Date,
  firstDownloadAt: Date | null,
  p: RetentionPolicy = DEFAULT_RETENTION,
): Date {
  if (!firstDownloadAt) {
    return new Date(completedAt.getTime() + Math.min(p.noDownloadHours, p.maxHours) * H);
  }
  return new Date(
    Math.min(firstDownloadAt.getTime() + p.afterDownloadHours * H, completedAt.getTime() + p.maxHours * H),
  );
}

/** "expira em 23 h 10 min" style text. */
export function formatRemaining(expiresAt: Date, now: Date = new Date()): string {
  const ms = expiresAt.getTime() - now.getTime();
  if (ms <= 0) return "expirado";
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function quotaLevel(usedBytes: number, quotaBytes: number): 0 | 70 | 85 | 95 {
  const pct = (usedBytes / quotaBytes) * 100;
  if (pct >= 95) return 95;
  if (pct >= 85) return 85;
  if (pct >= 70) return 70;
  return 0;
}
