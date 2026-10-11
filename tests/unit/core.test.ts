import { describe, expect, it } from "vitest";
import { backoffSeconds, classifyHttpStatus } from "../../supabase/functions/_shared/core/backoff.ts";
import { canTransition, progressOf, TRANSITIONS, WORK_STATES, STEP_EXECUTOR } from "../../supabase/functions/_shared/core/states.ts";
import { contentKey, expandSchedule, slotDedupeKey, tzOffsetMs, zonedToUtc } from "../../supabase/functions/_shared/core/schedule.ts";
import { computeVideoExpiry, formatBytes, formatRemaining, quotaLevel } from "../../supabase/functions/_shared/core/retention.ts";
import { estimateCostUsd, priceFor, estimateBeforeCall } from "../../supabase/functions/_shared/core/pricing.ts";
import { parseWav, pcmToWav, toWav, base64ToBytes, bytesToBase64 } from "../../supabase/functions/_shared/core/wav.ts";
import { open, redact, safeEqual, seal } from "../../supabase/functions/_shared/core/crypto.ts";
import type { Schedule } from "../../supabase/functions/_shared/core/types.ts";

describe("state machine", () => {
  it("every work state has an executor and can fail into retry_wait (except ready/terminal)", () => {
    for (const s of WORK_STATES) {
      expect(STEP_EXECUTOR[s]).toBeDefined();
      expect(canTransition(s, "retry_wait")).toBe(true);
      expect(canTransition(s, "cancelled")).toBe(true);
    }
  });
  it("published is terminal and never jumps back", () => {
    expect(TRANSITIONS.published).toEqual([]);
    expect(canTransition("rendering", "published")).toBe(false);
  });
  it("a render failure resumes rendering, not earlier steps", () => {
    expect(canTransition("retry_wait", "rendering")).toBe(true);
    expect(canTransition("validating", "rendering")).toBe(true);
  });
  it("progress", () => {
    expect(progressOf("scheduled")).toBe(0);
    expect(progressOf("published")).toBe(100);
    expect(progressOf("retry_wait", "rendering")).toBe(progressOf("rendering"));
  });
});

describe("backoff", () => {
  it("grows exponentially with a cap", () => {
    const r = () => 0;
    expect(backoffSeconds(1, { random: r })).toBe(60);
    expect(backoffSeconds(2, { random: r })).toBe(120);
    expect(backoffSeconds(5, { random: r })).toBe(960);
    expect(backoffSeconds(30, { random: r })).toBe(6 * 3600);
    expect(backoffSeconds(1, { random: () => 1 })).toBe(72);
  });
  it("classifies HTTP errors", () => {
    expect(classifyHttpStatus(429)).toBe("retryable");
    expect(classifyHttpStatus(503)).toBe("retryable");
    expect(classifyHttpStatus(401)).toBe("config");
    expect(classifyHttpStatus(400)).toBe("permanent");
  });
});

const baseSchedule: Schedule = {
  id: "s1",
  user_id: "u",
  work_id: "w",
  days_of_week: [1, 3, 5],
  time_of_day: "18:30",
  timezone: "America/Sao_Paulo",
  videos_per_slot: 1,
  target_duration_seconds: 75,
  summary_format: "chapter",
  platforms: ["youtube"],
  priority: 5,
  cost_limit_usd: 0.5,
  no_chapter_policy: "wait",
  replacement_format: "recap",
  lead_minutes: 180,
  starts_on: null,
  ends_on: null,
  active: true,
  materialized_until: null,
};

describe("calendar", () => {
  it("converts wall clock to UTC in São Paulo (UTC-3, no DST)", () => {
    expect(zonedToUtc(2026, 10, 12, 18, 30, "America/Sao_Paulo").toISOString()).toBe("2026-10-12T21:30:00.000Z");
    expect(tzOffsetMs(new Date("2026-10-12T21:30:00Z"), "America/Sao_Paulo")).toBe(-3 * 3600_000);
  });
  it("handles DST in New York", () => {
    expect(zonedToUtc(2026, 7, 1, 9, 0, "America/New_York").toISOString()).toBe("2026-07-01T13:00:00.000Z");
    expect(zonedToUtc(2026, 12, 1, 9, 0, "America/New_York").toISOString()).toBe("2026-12-01T14:00:00.000Z");
    // 02:30 does not exist on 2026-03-08: moves forward
    const gap = zonedToUtc(2026, 3, 8, 2, 30, "America/New_York");
    expect(gap.toISOString()).toBe("2026-03-08T07:30:00.000Z");
  });
  it("expands a week of slots on the configured days", () => {
    const slots = expandSchedule(baseSchedule, new Date("2026-10-11T00:00:00Z"), new Date("2026-10-18T00:00:00Z"));
    expect(slots.map((s) => s.slotAt.toISOString())).toEqual([
      "2026-10-12T21:30:00.000Z", // Monday
      "2026-10-14T21:30:00.000Z", // Wednesday
      "2026-10-16T21:30:00.000Z", // Friday
    ]);
    expect(slots[0].runAt.toISOString()).toBe("2026-10-12T18:30:00.000Z");
  });
  it("is deterministic (same slot -> same dedupe key)", () => {
    const a = expandSchedule(baseSchedule, new Date("2026-10-11T00:00:00Z"), new Date("2026-10-18T00:00:00Z"));
    const b = expandSchedule(baseSchedule, new Date("2026-10-12T00:00:00Z"), new Date("2026-10-17T00:00:00Z"));
    expect(b.map((s) => s.dedupeKey)).toEqual(a.map((s) => s.dedupeKey));
    expect(a[0].dedupeKey).toBe(slotDedupeKey("s1", new Date("2026-10-12T21:30:00Z"), 0));
  });
  it("respects videos_per_slot, start/end dates and inactive schedules", () => {
    const s = { ...baseSchedule, videos_per_slot: 2, starts_on: "2026-10-14", ends_on: "2026-10-14" };
    const slots = expandSchedule(s, new Date("2026-10-11T00:00:00Z"), new Date("2026-10-18T00:00:00Z"));
    expect(slots).toHaveLength(2);
    expect(new Set(slots.map((x) => x.dedupeKey)).size).toBe(2);
    expect(expandSchedule({ ...baseSchedule, active: false }, new Date("2026-10-11"), new Date("2026-10-18"))).toEqual([]);
  });
  it("content key", () => {
    expect(contentKey("w", "12", "chapter")).toBe("w:12:chapter");
  });
});

describe("retention (display mirror)", () => {
  const c = new Date("2026-10-10T00:00:00Z");
  it("matches the SQL rule", () => {
    expect(computeVideoExpiry(c, null).toISOString()).toBe("2026-10-12T00:00:00.000Z");
    expect(computeVideoExpiry(c, new Date("2026-10-10T05:00:00Z")).toISOString()).toBe("2026-10-11T05:00:00.000Z");
    expect(computeVideoExpiry(c, new Date("2026-10-11T20:00:00Z")).toISOString()).toBe("2026-10-12T00:00:00.000Z");
  });
  it("formats", () => {
    expect(formatRemaining(new Date("2026-10-10T02:30:00Z"), c)).toBe("2 h 30 min");
    expect(formatRemaining(new Date("2026-10-09T00:00:00Z"), c)).toBe("expirado");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(quotaLevel(860, 1000)).toBe(85);
    expect(quotaLevel(100, 1000)).toBe(0);
  });
});

describe("pricing", () => {
  it("free tier costs zero, paid tier uses dated prices", () => {
    expect(estimateCostUsd("gemini-3.8-flash", { inputTokens: 1e6, outputTokens: 1e6 }, "free")).toBe(0);
    expect(estimateCostUsd("gemini-3.8-flash", { inputTokens: 1e6, outputTokens: 1e6 }, "paid", new Date("2026-10-11"))).toBe(4.5);
    expect(estimateCostUsd("gemini-3.8-flash", { inputTokens: 1e6, outputTokens: 1e6 }, "paid", new Date("2027-02-01"))).toBe(9);
  });
  it("supports overrides and unknown models", () => {
    expect(priceFor("x-model").output).toBeGreaterThan(0);
    expect(priceFor("gemini-3.8-flash", new Date("2026-10-11"), { "gemini-3.8-flash": { input: 0.1 } }).input).toBe(0.1);
  });
  it("TTS estimate ~ $0.0015 per 10 s on flash-lite", () => {
    const v = estimateBeforeCall("gemini_tts", "gemini-3.8-flash-lite-tts", { audioSeconds: 10 }, "paid");
    expect(v).toBeCloseTo(0.0015, 4);
  });
});

describe("wav", () => {
  it("wraps PCM and measures the real duration", () => {
    const pcm = new Uint8Array(24000 * 2 * 3); // 3 s of 24 kHz mono 16-bit
    const wav = pcmToWav(pcm);
    const info = parseWav(wav);
    expect(info.durationSeconds).toBeCloseTo(3, 5);
    expect(toWav(pcm, "audio/L16;codec=pcm;rate=24000").length).toBe(wav.length);
    expect(toWav(wav, "audio/wav")).toBe(wav);
    expect(() => toWav(pcm, "audio/ogg")).toThrow();
  });
  it("base64 roundtrip", () => {
    const b = new Uint8Array([0, 1, 2, 250, 255]);
    expect(base64ToBytes(bytesToBase64(b))).toEqual(b);
  });
});

describe("crypto", () => {
  const key = bytesToBase64(new Uint8Array(32).fill(7));
  it("seals and opens, bound to its owner", async () => {
    const s = await seal("refresh-token-123", key, "u1:youtube");
    expect(s.ciphertext).not.toContain("refresh");
    expect(await open(s, key, "u1:youtube")).toBe("refresh-token-123");
    await expect(open(s, key, "u2:youtube")).rejects.toThrow();
  });
  it("redacts secrets from logs", () => {
    const t = redact('GET https://x?key=AIzaSyA1234567890123456789012 Authorization: Bearer abc.def {"refresh_token":"xyz"}');
    expect(t).not.toContain("AIzaSyA");
    expect(t).not.toContain("abc.def");
    expect(t).not.toContain("xyz");
  });
  it("safeEqual", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});
