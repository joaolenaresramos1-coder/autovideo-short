// Fake external services for tests (Gemini, YouTube, TikTok, file:// URLs).
// They follow the request/response formats of the real APIs so the
// production adapters are exercised unchanged.

import { readFileSync } from "node:fs";
import { bytesToBase64, pcmToWav } from "../../supabase/functions/_shared/core/wav.ts";

export interface FakeStats {
  calls: Record<string, number>;
  requests: { url: string; method: string; body?: unknown }[];
  youtubeBytes: number;
  tiktokBytes: number;
}

/** Tone-and-silence "speech": one tone per sentence, silence between them. */
export function fakeSpeech(text: string, wordsPerSecond = 2.6): Uint8Array {
  const rate = 24000;
  const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.trim());
  const chunks: Int16Array[] = [];
  for (const s of sentences) {
    const words = s.split(/\s+/).length;
    const n = Math.round((words / wordsPerSecond) * rate);
    const tone = new Int16Array(n);
    for (let i = 0; i < n; i++) tone[i] = Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * 8000);
    chunks.push(tone, new Int16Array(Math.round(0.45 * rate)));
  }
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const pcm = new Int16Array(total);
  let o = 0;
  for (const c of chunks) {
    pcm.set(c, o);
    o += c.length;
  }
  return pcmToWav(new Uint8Array(pcm.buffer));
}

const WORDS = "o jovem herdeiro descobre que a antiga promessa esconde um segredo perigoso e decide enfrentar o conselho sozinho enquanto aliados inesperados surgem no caminho revelando verdades sobre seu passado".split(" ");

function sentence(n: number, seed: number): string {
  const w: string[] = [];
  for (let i = 0; i < n; i++) w.push(WORDS[(seed * 7 + i * 3) % WORDS.length]);
  const s = w.join(" ");
  return s.charAt(0).toUpperCase() + s.slice(1) + ".";
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export interface FakeOptions {
  /** words/second of the fake narration (controls the audio duration) */
  speechRate?: number;
  /** override the script length the fake model writes (words) */
  scriptWords?: number;
}

export function createFakeFetch(opts: FakeOptions = {}) {
  const stats: FakeStats = { calls: {}, requests: [], youtubeBytes: 0, tiktokBytes: 0 };
  const hit = (k: string) => (stats.calls[k] = (stats.calls[k] ?? 0) + 1);
  let ytReceived = 0;
  /** Extra routes registered by a test: exact URL -> response factory. */
  const routes = new Map<string, (init: RequestInit) => Response>();

  const fetchFn = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    let body: any;
    if (typeof init.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    stats.requests.push({ url, method, body: typeof body === "object" ? body : undefined });

    const custom = routes.get(url);
    if (custom) {
      stats.calls[`route:${url}`] = (stats.calls[`route:${url}`] ?? 0) + 1;
      return custom(init);
    }

    // ---- signed URLs of the fake bucket
    if (url.startsWith("file://")) {
      const file = readFileSync(url.slice(7).split("?")[0]);
      const range = headers.get("range");
      const m = range && /bytes=(\d+)-(\d+)/.exec(range);
      if (m) {
        const slice = file.subarray(Number(m[1]), Number(m[2]) + 1);
        return new Response(slice, { status: 206 });
      }
      return new Response(file, { status: 200 });
    }

    // ---- Gemini
    if (url.startsWith("https://generativelanguage.googleapis.com/v1beta/models")) {
      if (method === "GET") {
        hit("gemini_models");
        const models = [
          { name: "models/gemini-3.8-flash", supportedGenerationMethods: ["generateContent"], inputTokenLimit: 1048576, outputTokenLimit: 65536 },
          { name: "models/gemini-3.8-flash-lite-tts", supportedGenerationMethods: ["generateContent"] },
        ];
        if (/models\/[^/?]+$/.test(new URL(url).pathname)) {
          const id = new URL(url).pathname.split("/").pop()!;
          return json(models.find((m) => m.name.endsWith(id)) ?? { name: `models/${id}`, supportedGenerationMethods: ["generateContent"] });
        }
        return json({ models });
      }
      if (headers.get("x-goog-api-key") !== "test-gemini-key") return json({ error: { message: "API key not valid" } }, 400);
      const cfg = body.generationConfig ?? {};
      const usageMetadata = { promptTokenCount: 1000, candidatesTokenCount: 500, totalTokenCount: 1500 };
      if (cfg.responseModalities?.includes("AUDIO")) {
        hit("gemini_tts");
        const text = body.contents[0].parts[0].text as string;
        const wav = fakeSpeech(text, opts.speechRate);
        return json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/wav", data: bytesToBase64(wav) } }] } }], usageMetadata });
      }
      if (cfg.responseModalities?.includes("IMAGE")) {
        hit("gemini_image");
        return json({ error: { message: "not in fake" } }, 400);
      }
      const schema = cfg.responseFormat?.text?.schema ?? cfg.responseJsonSchema;
      const required: string[] = schema?.required ?? [];
      const allText = (body.contents[0].parts as { text?: string }[]).map((p) => p.text ?? "").join("\n");
      let out: unknown;
      if (required.includes("batch_summary")) {
        hit("gemini_analysis");
        const ids = [...allText.matchAll(/Painel ([\w-]+):/g)].map((m) => m[1]);
        out = {
          panels: ids.map((id, i) => ({
            id,
            scene: `Cena ${i + 1}: o herdeiro encara o conselho`,
            characters: ["Ivan"],
            dialogues: [{ speaker: "Ivan", text: "I will never abandon my family no matter what happens tonight", meaning: "Ele promete proteger a família" }],
            usable: true,
          })),
          events: [{ description: "Ivan descobre o segredo da promessa", certainty: "confirmed", panels: ids.slice(0, 2) }],
          batch_summary: "Ivan enfrenta o conselho.",
        };
      } else if (required.includes("memory_updates")) {
        hit("gemini_script");
        const ids = (/Identificadores disponíveis: ([^\n]+)\./.exec(allText)?.[1] ?? "").split(", ").filter((x) => x && !x.startsWith("("));
        const target = opts.scriptWords ?? Number(/cerca de (\d+) palavras/.exec(allText)?.[1] ?? 180);
        const segs = 12;
        const per = Math.max(4, Math.round(target / segs));
        out = {
          title: "O segredo da promessa — resumo",
          description: "Resumo do capítulo com narração original.",
          hashtags: ["manhwa", "resumo"],
          hook: "Ninguém esperava essa revelação.",
          segments: Array.from({ length: segs }, (_, i) => ({
            text: sentence(per, i),
            panels: ids.length ? [ids[i % ids.length]] : [],
            emphasis: [WORDS[(i * 7) % WORDS.length]],
          })),
          key_points: { conflicts: ["Ivan contra o conselho"], revelations: ["A promessa esconde um segredo"], consequences: ["Ivan perde aliados"] },
          chapter_summary: "Ivan descobre o segredo da promessa e enfrenta o conselho.",
          memory_updates: [
            { kind: "character", name: "Ivan", content: "Herdeiro protagonista", certainty: "confirmed" },
            { kind: "event", name: "Promessa", content: "Pode ter sido feita pelo tio", certainty: "theory" },
          ],
        };
      } else if (required.includes("consistent")) {
        hit("gemini_review");
        out = { consistent: true, issues: [] };
      } else {
        out = {};
      }
      return json({ candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }], usageMetadata, modelVersion: "fake" });
    }

    // ---- YouTube
    if (url.startsWith("https://www.googleapis.com/upload/youtube/v3/videos")) {
      hit("youtube_start");
      ytReceived = 0;
      return new Response("", { status: 200, headers: { location: "https://upload.fake/youtube/session-1" } });
    }
    if (url.startsWith("https://upload.fake/youtube/")) {
      const cr = headers.get("content-range") ?? "";
      const total = Number(/\/(\d+)$/.exec(cr)?.[1] ?? 0);
      if (cr.startsWith("bytes */")) {
        if (ytReceived >= total && total > 0) return json({ id: "yt-video-1" }, 200);
        return new Response("", { status: 308, headers: ytReceived ? { range: `bytes=0-${ytReceived - 1}` } : {} });
      }
      hit("youtube_chunk");
      const len = (init.body as Uint8Array).length;
      ytReceived += len;
      stats.youtubeBytes += len;
      if (ytReceived >= total) return json({ id: "yt-video-1", status: { uploadStatus: "uploaded" } }, 201);
      return new Response("", { status: 308, headers: { range: `bytes=0-${ytReceived - 1}` } });
    }
    if (url.startsWith("https://www.googleapis.com/youtube/v3/videos")) {
      hit("youtube_status");
      return json({ items: [{ status: { uploadStatus: "processed", privacyStatus: "private" }, processingDetails: { processingStatus: "succeeded" } }] });
    }

    // ---- TikTok
    if (url === "https://open.tiktokapis.com/v2/post/publish/creator_info/query/") {
      hit("tiktok_creator");
      return json({ data: { privacy_level_options: ["SELF_ONLY"], max_video_post_duration_sec: 600 }, error: { code: "ok" } });
    }
    if (url === "https://open.tiktokapis.com/v2/post/publish/video/init/") {
      hit("tiktok_init");
      return json({ data: { publish_id: "tt-publish-1", upload_url: "https://upload.fake/tiktok/1" }, error: { code: "ok" } });
    }
    if (url.startsWith("https://upload.fake/tiktok/")) {
      hit("tiktok_chunk");
      stats.tiktokBytes += (init.body as Uint8Array).length;
      return new Response("", { status: 201 });
    }
    if (url === "https://open.tiktokapis.com/v2/post/publish/status/fetch/") {
      hit("tiktok_status");
      return json({ data: { status: "PUBLISH_COMPLETE", publicaly_available_post_id: [] }, error: { code: "ok" } });
    }

    // ---- GitHub dispatch
    if (url.startsWith("https://api.github.com/")) {
      hit("github_dispatch");
      return new Response(null, { status: 204 });
    }
    return new Response(`fake: rota não mapeada ${method} ${url}`, { status: 404 });
  };
  return { fetchFn, stats, routes };
}
