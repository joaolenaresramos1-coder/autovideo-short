import { describe, expect, it } from "vitest";
import { assColor, assTime, buildAss, segmentRanges, timeWords } from "../../supabase/functions/_shared/core/captions.ts";
import { buildFfmpegArgs, planShots } from "../../supabase/functions/_shared/core/render.ts";
import {
  boundsFor, copiedPassages, fillMissingPanels, fitDuration, normalizeScript, validateScript,
} from "../../supabase/functions/_shared/core/script.ts";
import { memoryContext, mergeMemory } from "../../supabase/functions/_shared/core/memory.ts";
import { validateVideo } from "../../supabase/functions/_shared/core/validation.ts";
import type { Panel, ScriptSegment } from "../../supabase/functions/_shared/core/types.ts";

const segments: ScriptSegment[] = [
  { text: "Ele acordou no corpo de um camponês.", panels: ["p1"], emphasis: ["camponês"] },
  { text: "Mas, aos quatro anos, já sabia o que fazer!", panels: ["p2", "p3"] },
];

describe("captions", () => {
  it("covers the audio proportionally and in order", () => {
    const w = timeWords(segments, 10);
    expect(w.map((x) => x.text)).toEqual([
      "ELE", "ACORDOU", "NO", "CORPO", "DE", "UM", "CAMPONÊS", "MAS", "AOS", "QUATRO", "ANOS", "JÁ", "SABIA", "O", "QUE", "FAZER!",
    ]);
    for (let i = 1; i < w.length; i++) expect(w[i].start).toBeGreaterThanOrEqual(w[i - 1].end);
    expect(w[w.length - 1].end).toBeLessThanOrEqual(10);
    expect(w.find((x) => x.text === "CAMPONÊS")?.emphasis).toBe(true);
  });
  it("aligns words to detected speech intervals", () => {
    const w = timeWords(segments, 12, [{ start: 0.5, end: 4.5 }, { start: 6, end: 11 }]);
    expect(w[0].start).toBeCloseTo(0.5, 3);
    for (const x of w) {
      const inside = (x.start >= 0.5 - 1e-6 && x.start <= 4.5) || (x.start >= 6 - 1e-6 && x.start <= 11);
      expect(inside).toBe(true);
    }
  });
  it("segment ranges are contiguous and cover the duration", () => {
    const w = timeWords(segments, 10);
    const r = segmentRanges(w, 2, 10);
    expect(r[0].start).toBe(0);
    expect(r[1].start).toBe(r[0].end);
    expect(r[1].end).toBe(10);
  });
  it("produces a valid ASS file", () => {
    const ass = buildAss(timeWords(segments, 10), { font: "Anton", color: "#FFE600", accent: "#7CFF4F", outline: 8 });
    expect(ass).toContain("PlayResX: 1080");
    expect(ass.match(/^Dialogue:/gm)).toHaveLength(16);
    expect(ass).toContain("\\c&H004FFF7C"); // accent on emphasis word
    expect(assColor("#FFE600")).toBe("&H0000E6FF");
    expect(assTime(61.234)).toBe("0:01:01.23");
  });
});

const panels: Panel[] = [
  { id: "p1", path: "a", width: 1080, height: 1920 },
  { id: "p2", path: "b", width: 800, height: 4000 },
  { id: "p3", path: "c", width: 1600, height: 900 },
];

describe("render plan", () => {
  it("covers the whole duration with short moving shots", () => {
    const ranges = [{ start: 0, end: 7 }, { start: 7, end: 12 }];
    const shots = planShots(segments, ranges, panels, 12);
    const total = shots.reduce((a, s) => a + s.duration, 0);
    expect(total).toBeCloseTo(12, 2);
    expect(shots.find((s) => s.panelId === "p2")?.motion).toBe("pan_down");
    expect(shots.find((s) => s.panelId === "p3")?.motion).toBe("pan_right");
    // the same image never restarts its movement on the next shot
    for (let i = 1; i < shots.length; i++) expect(shots[i].panelId).not.toBe(shots[i - 1].panelId);
    for (let i = 1; i < shots.length; i++) expect(shots[i].start).toBeCloseTo(shots[i - 1].start + shots[i - 1].duration, 2);
  });
  it("falls back to available panels when a segment has none", () => {
    const shots = planShots([{ text: "x", panels: ["missing"] }], [{ start: 0, end: 2 }], panels, 2);
    expect(shots[0].panelId).toBe("p1");
  });
  it("builds an ffmpeg command with captions, audio and fixed output", () => {
    const shots = planShots(segments, [{ start: 0, end: 3 }, { start: 3, end: 6 }], panels, 6);
    const args = buildFfmpegArgs({
      shots,
      images: { p1: "/t/p1.png", p2: "/t/p2.png", p3: "/t/p3.png" },
      audioPath: "/t/a.wav",
      assPath: "/t/c.ass",
      duration: 6,
      outputPath: "/t/out.mp4",
      tempo: 1.05,
    });
    const fc = args[args.indexOf("-filter_complex") + 1];
    expect(fc).toContain(`concat=n=${shots.length}`);
    expect(fc).toContain("subtitles='/t/c.ass'");
    expect(fc).toContain("atempo=1.0500");
    expect(args).toContain("1080x1920");
    expect(args[args.length - 1]).toBe("/t/out.mp4");
  });
});

describe("script checks", () => {
  it("duration decisions", () => {
    expect(boundsFor(75)).toEqual({ min: 60, max: 90 });
    expect(boundsFor(180)).toEqual({ min: 144, max: 180 });
    expect(fitDuration(80, 75, 200, true)).toEqual({ action: "ok", videoSeconds: 80 });
    expect(fitDuration(95, 75, 250, true)).toMatchObject({ action: "tempo" });
    expect(fitDuration(57, 75, 150, true)).toMatchObject({ action: "pad", videoSeconds: 60 });
    const r = fitDuration(40, 75, 100, true);
    expect(r.action).toBe("rewrite");
    if (r.action === "rewrite") expect(r.targetWords).toBe(Math.round(75 * 2.5));
    // without another rewrite allowed, a too-short narration is never stretched beyond limits
    expect(fitDuration(40, 75, 100, false).action).toBe("rewrite");
  });
  it("detects copied dialogue", () => {
    const src = ["Eu nunca vou perdoar quem destruiu a minha família naquela noite"];
    expect(copiedPassages("Ele grita: eu nunca vou perdoar quem destruiu a minha família", src)).toHaveLength(1);
    expect(copiedPassages("Ele jura vingança contra quem arrasou sua família", src)).toHaveLength(0);
  });
  it("normalizes AI output and validates it", () => {
    const s = normalizeScript(
      {
        title: "T".repeat(150),
        segments: [{ text: " a  b ", panels: ["p1", "zzz"] }, { text: "" }, { text: "c", panels: [] }],
        hashtags: ["manhwa", "#resumo!"],
      },
      panels,
    );
    expect(s.title).toHaveLength(100);
    expect(s.segments).toHaveLength(2);
    expect(s.segments[0]).toMatchObject({ text: "a b", panels: ["p1"] });
    expect(s.hashtags).toEqual(["#manhwa", "#resumo"]);
    const issues = validateScript(s, { targetSeconds: 60, sourceDialogues: [], requirePanels: true });
    expect(issues.some((i) => i.level === "error")).toBe(true);
    const filled = fillMissingPanels(s, panels);
    expect(filled.segments[1].panels).toEqual(["p2"]);
  });
});

describe("narrative memory", () => {
  it("a theory never overwrites a confirmed fact", () => {
    const existing = [{ kind: "power" as const, name: "Ivan", content: "Controla gelo", certainty: "confirmed" as const }];
    const r = mergeMemory(existing, [
      { kind: "power", name: "ivan", content: "Talvez controle fogo", certainty: "theory" },
      { kind: "character", name: "Lia", content: "Irmã de Ivan", certainty: "confirmed" },
    ], "12");
    expect(r.upserts.map((u) => u.name)).toEqual(["Lia"]);
    expect(r.rejected).toHaveLength(1);
  });
  it("a confirmed change supersedes and interpretations upgrade theories", () => {
    const existing = [
      { kind: "relationship" as const, name: "Ivan/Lia", content: "Aliados", certainty: "confirmed" as const },
      { kind: "event" as const, name: "Traidor", content: "Pode ser o tio", certainty: "theory" as const },
    ];
    const r = mergeMemory(existing, [
      { kind: "relationship", name: "Ivan/Lia", content: "Inimigos após a traição", certainty: "confirmed", supersedes: true },
      { kind: "event", name: "Traidor", content: "Indícios apontam para o tio", certainty: "interpretation" },
    ], "13");
    expect(r.upserts).toHaveLength(2);
    expect(r.upserts[1].certainty).toBe("interpretation");
  });
  it("labels certainty in the prompt context", () => {
    const t = memoryContext([
      { kind: "character", name: "Ivan", content: "Protagonista", certainty: "confirmed" },
      { kind: "character", name: "Rei", content: "Pode estar vivo", certainty: "theory" },
    ]);
    expect(t).toContain("[FATO] Ivan");
    expect(t).toContain("[TEORIA] Rei");
  });
});

describe("video validation", () => {
  const probe = {
    streams: [
      { codec_type: "video", codec_name: "h264", width: 1080, height: 1920, pix_fmt: "yuv420p" },
      { codec_type: "audio", codec_name: "aac" },
    ],
    format: { duration: "75.02", size: "9000000", format_name: "mov,mp4" },
  };
  it("accepts a good file", () => {
    const r = validateVideo({ probe, decodeErrors: "", expectedDuration: 75, minSeconds: 60, maxSeconds: 90, captionEvents: 100, captionsRequired: true });
    expect(r.ok).toBe(true);
  });
  it("rejects missing audio, wrong size, decode errors and missing captions", () => {
    const bad = { ...probe, streams: [{ ...probe.streams[0], width: 720 }] };
    const r = validateVideo({ probe: bad, decodeErrors: "corrupt frame", expectedDuration: 75, minSeconds: 60, maxSeconds: 90, captionEvents: 0, captionsRequired: true });
    expect(r.ok).toBe(false);
    expect(r.checks.filter((c) => !c.ok).map((c) => c.name).sort()).toEqual(["decodificação", "legendas", "resolução", "áudio"].sort());
  });
});

describe("file size budget", () => {
  it("caps the bitrate so 3 minutes fit in the 50 MB upload limit", async () => {
    const { videoBitrateFor, MAX_FILE_BYTES } = await import("../../supabase/functions/_shared/core/render.ts");
    const kbps = videoBitrateFor(180);
    const bytes = ((kbps + 160) * 1000 * 180) / 8;
    expect(bytes).toBeLessThan(MAX_FILE_BYTES);
    expect(videoBitrateFor(60)).toBeGreaterThan(kbps);
  });
});

describe("render plan: images follow the narration", () => {
  const pages: Panel[] = [
    { id: "p001-1", path: "a", width: 1080, height: 1600, page: 1 },
    { id: "p001-2", path: "b", width: 1080, height: 1600, page: 1 },
    { id: "p002-1", path: "c", width: 1080, height: 1600, page: 2 },
  ];
  it("one continuous shot when consecutive segments show the same image", () => {
    const segs: ScriptSegment[] = [{ text: "a", panels: ["p002-1"] }, { text: "b", panels: ["p002-1"] }];
    const shots = planShots(segs, [{ start: 0, end: 2 }, { start: 2, end: 4 }], pages, 4);
    expect(shots).toHaveLength(1);
    expect(shots[0]).toMatchObject({ panelId: "p002-1", duration: 4, motion: "zoom_in" });
  });
  it("a long segment shows the other slices of the same page, never another scene", () => {
    const shots = planShots([{ text: "longo", panels: ["p001-1"] }], [{ start: 0, end: 8 }], pages, 8);
    expect(shots.map((s) => s.panelId)).toEqual(["p001-1", "p001-2"]);
  });
  it("a segment without image keeps the one on screen", () => {
    const segs: ScriptSegment[] = [{ text: "a", panels: ["p002-1"] }, { text: "b", panels: [] }];
    const shots = planShots(segs, [{ start: 0, end: 2 }, { start: 2, end: 3 }], pages, 3);
    expect(shots.map((s) => s.panelId)).toEqual(["p002-1"]);
  });
  it("missing images are chosen by what is being narrated", () => {
    const script = {
      title: "t", description: "d", hashtags: [], hook: "h",
      segments: [
        { text: "Ivan encara o conselho.", panels: ["p001-1"] },
        { text: "A espada de Lia brilha no escuro.", panels: [] },
      ],
    };
    const filled = fillMissingPanels(script as never, pages, {
      "p001-1": "Ivan diante do conselho", "p001-2": "corredor vazio", "p002-1": "Lia ergue a espada que brilha",
    });
    expect(filled.segments[1].panels).toEqual(["p002-1"]);
  });
});

describe("captions: position and real timing", async () => {
  const { alignToHeard, CAPTION_Y } = await import("../../supabase/functions/_shared/core/captions.ts");
  it("bottom by default, above the platform description; top and middle on request", () => {
    const words = timeWords(segments, 10);
    const style = { font: "Anton", color: "#FFE600", accent: "#7CFF4F", outline: 8 };
    expect(buildAss(words, style)).toContain(`\\pos(502,${Math.round(CAPTION_Y.bottom * 1920)})`);
    expect(CAPTION_Y.bottom * 1920).toBeLessThan(1920 * 0.7);
    expect(buildAss(words, { ...style, position: "top" })).toContain(`\\pos(540,${Math.round(0.24 * 1920)})`);
    expect(buildAss(words, { ...style, position: "middle" })).toContain(`,960)`);
  });
  it("words take the times heard in the narration, even when the voice starts late", () => {
    // the voice starts at 2.5 s; "camponês" was heard as "campones", "quatro" was not heard
    const heard = [
      ["Ele", 2.5, 2.7], ["acordou", 2.7, 3.2], ["no", 3.2, 3.3], ["corpo", 3.3, 3.7], ["de", 3.7, 3.8], ["um", 3.8, 3.9], ["campones", 3.9, 4.6],
      ["Mas", 5.4, 5.6], ["aos", 5.6, 5.8], ["anos", 6.4, 6.8], ["já", 6.8, 7.0], ["sabia", 7.0, 7.4], ["o", 7.4, 7.5], ["que", 7.5, 7.7], ["fazer", 7.7, 8.2],
    ].map(([w, s, e]) => ({ w: w as string, s: s as number, e: e as number }));
    const words = alignToHeard(segments, heard)!;
    expect(words[0]).toMatchObject({ text: "ELE", start: 2.5 });
    expect(words.find((w) => w.text === "CAMPONÊS")).toMatchObject({ start: 3.9, end: 4.6 });
    const quatro = words.find((w) => w.text === "QUATRO")!;
    expect(quatro.start).toBeGreaterThanOrEqual(5.8);
    expect(quatro.end).toBeLessThanOrEqual(6.4);
    // tempo-adjusted audio: times are divided by the tempo
    expect(alignToHeard(segments, heard, 1.25)![0].start).toBe(2);
    // nothing in common: not trusted
    expect(alignToHeard(segments, [{ w: "xyz", s: 0, e: 1 }])).toBeNull();
  });
});
