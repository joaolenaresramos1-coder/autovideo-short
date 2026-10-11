// Calendar expansion with real IANA time zones (no external libraries, works
// in Deno, Node and the browser through Intl).

import type { Schedule } from "./types.ts";

/** Offset (ms) of `timeZone` at the given UTC instant: local = utc + offset. */
export function tzOffsetMs(utc: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(dtf.formatToParts(utc).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - Math.floor(utc.getTime() / 1000) * 1000;
}

/**
 * Convert a wall-clock time in `timeZone` to a UTC instant. Times that do not
 * exist (DST gap) move forward; ambiguous times (DST overlap) use the first.
 */
export function zonedToUtc(
  y: number,
  m: number, // 1..12
  d: number,
  hh: number,
  mm: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  // The offset may differ on each side of a DST change: try both.
  const t1 = guess - tzOffsetMs(new Date(guess - 12 * 3600_000), timeZone);
  const t2 = guess - tzOffsetMs(new Date(guess + 12 * 3600_000), timeZone);
  const matches = (t: number) => t + tzOffsetMs(new Date(t), timeZone) === guess;
  const valid = [t1, t2].filter(matches);
  // Overlap: both valid -> first occurrence. Gap: none valid -> later instant.
  return new Date(valid.length > 0 ? Math.min(...valid) : Math.max(t1, t2));
}

/** Local calendar date (y, m, d, weekday) of an instant in a time zone. */
export function localDate(utc: Date, timeZone: string) {
  const local = new Date(utc.getTime() + tzOffsetMs(utc, timeZone));
  return {
    y: local.getUTCFullYear(),
    m: local.getUTCMonth() + 1,
    d: local.getUTCDate(),
    weekday: local.getUTCDay(), // 0 = Sunday
  };
}

export function parseTimeOfDay(t: string): { hh: number; mm: number } {
  const m = /^(\d{1,2}):(\d{2})/.exec(t);
  if (!m) throw new Error(`Horário inválido: ${t}`);
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) throw new Error(`Horário inválido: ${t}`);
  return { hh, mm };
}

export interface Slot {
  /** Publication instant (UTC). */
  slotAt: Date;
  /** When production should start (slotAt - lead). */
  runAt: Date;
  /** Index inside the slot when videos_per_slot > 1. */
  index: number;
  dedupeKey: string;
}

/** Deterministic key: the same schedule slot always yields the same key. */
export function slotDedupeKey(scheduleId: string, slotAt: Date, index: number): string {
  return `slot:${scheduleId}:${slotAt.toISOString()}:${index}`;
}

/**
 * Slots of a schedule whose publication time is in [from, to).
 * Production starts `lead_minutes` before; slots whose run time already
 * passed are still returned (the queue starts them immediately).
 */
export function expandSchedule(s: Schedule, from: Date, to: Date): Slot[] {
  if (!s.active) return [];
  const { hh, mm } = parseTimeOfDay(s.time_of_day);
  const out: Slot[] = [];
  const days = new Set(s.days_of_week);
  // Walk local calendar days covering the range (+/- 1 day for offsets).
  const start = localDate(new Date(from.getTime() - 86400_000), s.timezone);
  let cursor = Date.UTC(start.y, start.m - 1, start.d);
  const end = to.getTime() + 2 * 86400_000;
  while (cursor <= end) {
    const day = new Date(cursor);
    const y = day.getUTCFullYear();
    const m = day.getUTCMonth() + 1;
    const d = day.getUTCDate();
    const iso = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const inRange = (!s.starts_on || iso >= s.starts_on) && (!s.ends_on || iso <= s.ends_on);
    if (inRange && days.has(day.getUTCDay())) {
      const slotAt = zonedToUtc(y, m, d, hh, mm, s.timezone);
      if (slotAt >= from && slotAt < to) {
        for (let i = 0; i < s.videos_per_slot; i++) {
          out.push({
            slotAt,
            runAt: new Date(slotAt.getTime() - s.lead_minutes * 60_000),
            index: i,
            dedupeKey: slotDedupeKey(s.id, slotAt, i),
          });
        }
      }
    }
    cursor += 86400_000;
  }
  return out.sort((a, b) => a.slotAt.getTime() - b.slotAt.getTime() || a.index - b.index);
}

/** Content key prevents two videos about the same chapter in the same format. */
export function contentKey(workId: string, chapterKey: string, format: string): string {
  return `${workId}:${chapterKey}:${format}`;
}
