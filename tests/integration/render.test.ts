// Real FFmpeg render of the reference style (no database): word-by-word
// captions, moving shots, 1080x1920, then validation of the output.

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAss, segmentRanges, timeWords } from "../../supabase/functions/_shared/core/captions.ts";
import { buildFfmpegArgs, planShots } from "../../supabase/functions/_shared/core/render.ts";
import { parseWav } from "../../supabase/functions/_shared/core/wav.ts";
import { validateVideo } from "../../supabase/functions/_shared/core/validation.ts";
import type { Panel, ScriptSegment } from "../../supabase/functions/_shared/core/types.ts";
import { decodeErrors, ffprobe, run, speechIntervals } from "../../worker/ffmpeg.ts";
import { fakeSpeech } from "../support/fakes.ts";

const OUT_DIR = process.env.RENDER_TEST_OUT;

describe("ffmpeg render", () => {
  it("renders and validates a short vertical video", async () => {
    const dir = OUT_DIR ?? (await mkdtemp(join(tmpdir(), "render-")));
    const panels: Panel[] = [
      { id: "a", path: "", width: 1080, height: 1920 },
      { id: "b", path: "", width: 720, height: 3000 },
      { id: "c", path: "", width: 1600, height: 900 },
    ];
    const sources = { a: "mandelbrot=s=1080x1920", b: "testsrc2=s=720x3000", c: "cellauto=s=1600x900:rule=110" };
    const images: Record<string, string> = {};
    for (const [id, src] of Object.entries(sources)) {
      images[id] = join(dir, `${id}.png`);
      execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", src, "-frames:v", "1", images[id]]);
    }
    const segments: ScriptSegment[] = [
      { text: "Ele acordou no corpo de um camponês de quatro anos.", panels: ["a"], emphasis: ["camponês"] },
      { text: "Mas lembrava de tudo da vida passada, inclusive das armas.", panels: ["b"], emphasis: ["armas"] },
      { text: "E decidiu que, desta vez, ninguém iria detê-lo!", panels: ["c", "a"], emphasis: ["ninguém"] },
    ];
    const wav = fakeSpeech(segments.map((s) => s.text).join(" "));
    const audio = join(dir, "narration.wav");
    await writeFile(audio, wav);
    const duration = parseWav(wav).durationSeconds;
    const speech = await speechIntervals(audio, duration);
    expect(speech.length).toBeGreaterThanOrEqual(3);
    const words = timeWords(segments, duration, speech);
    const ranges = segmentRanges(words, segments.length, duration);
    const shots = planShots(segments, ranges, panels, duration);
    const ass = join(dir, "c.ass");
    await writeFile(ass, buildAss(words, { font: "DejaVu Sans", color: "#FFE600", accent: "#7CFF4F", outline: 8 }));
    const out = join(dir, "out.mp4");
    const r = await run("ffmpeg", buildFfmpegArgs({ shots, images, audioPath: audio, assPath: ass, duration, outputPath: out, preset: "ultrafast" }));
    expect(r.code, r.stderr.slice(-800)).toBe(0);

    const report = validateVideo({
      probe: await ffprobe(out),
      decodeErrors: await decodeErrors(out),
      expectedDuration: duration,
      minSeconds: 0,
      maxSeconds: 180,
      captionEvents: words.length,
      captionsRequired: true,
    });
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
  });
});
