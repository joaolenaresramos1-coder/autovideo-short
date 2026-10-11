import { describe, expect, it } from "vitest";
import { GeminiClient, inferCapabilities } from "../../supabase/functions/_shared/adapters/gemini.ts";
import { authorizeUrl, needsRefresh } from "../../supabase/functions/_shared/adapters/oauth.ts";
import { buildVideoResource, interpretYouTubeStatus } from "../../supabase/functions/_shared/adapters/youtube.ts";
import { chunkPlan, choosePrivacy, interpretTikTokStatus } from "../../supabase/functions/_shared/adapters/tiktok.ts";
import { memorySource } from "../../supabase/functions/_shared/adapters/bytes.ts";
import { mangadex, mangadexId, mdLanguage } from "../../supabase/functions/_shared/connectors/mangadex.ts";
import { anilistId, parseFeed } from "../../supabase/functions/_shared/connectors/others.ts";
import { detectSource } from "../../supabase/functions/_shared/connectors/index.ts";
import { chapterNumberFrom } from "../../supabase/functions/_shared/connectors/types.ts";
import type { Work } from "../../supabase/functions/_shared/core/types.ts";

type Call = { url: string; init: RequestInit };
function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  };
  return { f, calls };
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

const work = (extra: Partial<Work> = {}): Work => ({
  id: "w", user_id: "u", title: "T", type: "manga", url: null, source: "mangadex", source_ref: null, language: "pt-BR",
  monitor_interval_minutes: 360, summary_format: "chapter", target_platforms: [], visual_mode: "source_panels",
  last_processed_chapter: null, status: "active", status_reason: null, authorization_status: "unknown", authorization_notes: null, ...extra,
});

describe("connectors", () => {
  const id = "a1c7c817-4e59-43b7-9365-09675a149a6f";
  it("detects sources from links", () => {
    expect(detectSource(`https://mangadex.org/title/${id}/one-piece`)).toBe("mangadex");
    expect(detectSource("https://anilist.co/anime/21/one-piece")).toBe("anilist");
    expect(detectSource("https://site.com/feed/")).toBe("rss");
    expect(detectSource("https://qualquer.site/obra")).toBe("manual");
    expect(mangadexId({ source_ref: null, url: `https://mangadex.org/title/${id}/x` })).toBe(id);
    expect(anilistId({ source_ref: null, url: "https://anilist.co/anime/21/x" })).toBe(21);
    expect(mdLanguage("pt-BR")).toBe("pt-br");
    expect(chapterNumberFrom("Capítulo 12.5 - O retorno")).toBe(12.5);
    expect(chapterNumberFrom("Episode 7")).toBe(7);
  });

  it("MangaDex: lists chapters (dedupes groups, skips external) and gates pages behind authorization", async () => {
    const { f, calls } = mockFetch((url) => {
      if (url.includes("/feed")) {
        return json({
          total: 4, limit: 500, offset: 0,
          data: [
            { id: "c1", attributes: { chapter: "1", title: "Início", pages: 20, publishAt: "2026-01-01T00:00:00Z", externalUrl: null, translatedLanguage: "pt-br" } },
            { id: "c1b", attributes: { chapter: "1", title: "Outro grupo", pages: 20, publishAt: "2026-01-01T00:00:00Z", externalUrl: null, translatedLanguage: "pt-br" } },
            { id: "c2", attributes: { chapter: "2", title: null, pages: 0, publishAt: "2026-01-08T00:00:00Z", externalUrl: "https://mangaplus", translatedLanguage: "pt-br" } },
            { id: "c3", attributes: { chapter: "3", title: null, pages: 18, publishAt: "2026-01-15T00:00:00Z", externalUrl: null, translatedLanguage: "pt-br" } },
          ],
        });
      }
      if (url.includes("/at-home/server/")) {
        return json({ baseUrl: "https://node.example:443/token", chapter: { hash: "h", data: ["1.png"], dataSaver: ["1.jpg", "2.jpg"] } });
      }
      return json({ data: { attributes: { title: { en: "Obra" } } } });
    });
    const w = work({ source_ref: id });
    const chapters = await mangadex.listChapters(w, f);
    expect(chapters.map((c) => c.key)).toEqual(["1", "3"]);
    expect(calls[0].url).toContain("translatedLanguage%5B%5D=pt-br");
    expect((calls[0].init.headers as Record<string, string>)["user-agent"]).toMatch(/AutoVideoShort/);
    await expect(mangadex.pageRefs!(w, { source_chapter_id: "c1", chapter_key: "1" }, f)).rejects.toThrow(/Autorização/);
    const refs = await mangadex.pageRefs!(work({ source_ref: id, authorization_status: "authorized" }), { source_chapter_id: "c1", chapter_key: "1" }, f);
    expect(refs.map((r) => r.url)).toEqual(["https://node.example:443/token/data-saver/h/1.jpg", "https://node.example:443/token/data-saver/h/2.jpg"]);
    expect(refs[0].reportTo).toBe("https://api.mangadex.network/report");
    const check = await mangadex.check(w, f);
    expect(check.status).toBe("active");
    expect(check.canFetchPages).toBe(false);
  });

  it("MangaDex without a valid link stays pending configuration", async () => {
    const { f } = mockFetch(() => json({}));
    const c = await mangadex.check(work({ url: "https://outro.site/x" }), f);
    expect(c.status).toBe("pending_config");
  });

  it("parses RSS and Atom feeds", () => {
    const rss = `<rss><channel><item><title>Obra - Capítulo 41</title><link>https://x/41</link><guid>g41</guid><pubDate>Mon, 05 Oct 2026 10:00:00 GMT</pubDate></item>
      <item><title><![CDATA[Obra &amp; Cia - Cap. 42]]></title><link>https://x/42</link></item></channel></rss>`;
    const items = parseFeed(rss);
    expect(items.map((i) => i.key)).toEqual(["41", "42"]);
    expect(items[1].title).toBe("Obra & Cia - Cap. 42");
    expect(items[0].publishedAt).toBe("2026-10-05T10:00:00.000Z");
    const atom = `<feed><entry><title>Chapter 3</title><link href="https://y/3"/><id>tag:3</id><updated>2026-10-01T00:00:00Z</updated></entry></feed>`;
    expect(parseFeed(atom)[0]).toMatchObject({ key: "3", url: "https://y/3" });
  });
});

describe("gemini client", () => {
  it("sends structured output with responseFormat and the API key header (never in the URL)", async () => {
    const { f, calls } = mockFetch(() =>
      json({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 2, totalTokenCount: 17 } }),
    );
    const r = await new GeminiClient("KEY", f).generateJson<{ ok: boolean }>("gemini-3.8-flash", [{ text: "oi" }], { type: "object" });
    expect(r.data.ok).toBe(true);
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 7, totalTokens: 17 });
    expect(calls[0].url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent");
    expect(calls[0].url).not.toContain("KEY");
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.generationConfig.responseFormat.text.mimeType).toBe("APPLICATION_JSON");
  });

  it("falls back to responseJsonSchema when responseFormat is rejected", async () => {
    let n = 0;
    const { f, calls } = mockFetch(() => {
      n++;
      if (n === 1) return json({ error: { message: 'Invalid JSON payload received. Unknown name "responseFormat"' } }, 400);
      return json({ candidates: [{ content: { parts: [{ text: "{}" }] } }] });
    });
    await new GeminiClient("KEY", f).generateJson("m", [{ text: "x" }], { type: "object" });
    expect(JSON.parse(calls[1].init.body as string).generationConfig.responseJsonSchema).toEqual({ type: "object" });
  });

  it("refuses to treat a text-only model as TTS", async () => {
    const { f } = mockFetch(() => json({ candidates: [{ content: { parts: [{ text: "não sei falar" }] } }] }));
    await expect(new GeminiClient("KEY", f).synthesize("gemini-3.8-flash", "Olá", { voice: "Kore" })).rejects.toThrow(/não oferece geração de fala/);
    expect(inferCapabilities({ name: "models/gemini-3.8-flash-lite-tts", supportedGenerationMethods: ["generateContent"] })).toEqual(["tts"]);
    expect(inferCapabilities({ name: "models/gemini-3.8-flash", supportedGenerationMethods: ["generateContent"] })).toEqual(["text"]);
    expect(inferCapabilities({ name: "models/embedding", supportedGenerationMethods: ["embedContent"] })).toEqual([]);
  });

  it("classifies errors: 429 retryable, 401/403 configuration", async () => {
    const r429 = mockFetch(() => new Response("quota", { status: 429, headers: { "retry-after": "30" } }));
    await expect(new GeminiClient("KEY", r429.f).generateJson("m", [{ text: "x" }], {})).rejects.toMatchObject({ kind: "retryable", retryAfterSeconds: 30 });
    const r403 = mockFetch(() => new Response("denied", { status: 403 }));
    await expect(new GeminiClient("KEY", r403.f).generateJson("m", [{ text: "x" }], {})).rejects.toMatchObject({ kind: "config" });
  });
});

describe("youtube / tiktok / oauth", () => {
  it("schedules with publishAt only for future slots", () => {
    const future = new Date(Date.now() + 3 * 3600_000).toISOString();
    const r = buildVideoResource({ title: "x".repeat(150), description: "d", tags: ["#a"], privacyStatus: "public", publishAt: future });
    expect(r.snippet.title).toHaveLength(100);
    expect(r.status).toMatchObject({ privacyStatus: "private", publishAt: new Date(future).toISOString(), selfDeclaredMadeForKids: false });
    const now = buildVideoResource({ title: "x", description: "d", tags: [], privacyStatus: "public", publishAt: new Date().toISOString() });
    expect(now.status.privacyStatus).toBe("public");
  });
  it("only declares published when YouTube reports the video processed", () => {
    expect(interpretYouTubeStatus({ exists: true, uploadStatus: "uploaded" }).state).toBe("processing");
    expect(interpretYouTubeStatus({ exists: true, uploadStatus: "processed", privacyStatus: "public" }).state).toBe("published");
    expect(interpretYouTubeStatus({ exists: true, uploadStatus: "rejected", rejectionReason: "duplicate" }).state).toBe("failed");
    expect(interpretYouTubeStatus({ exists: false }).state).toBe("failed");
    const later = new Date(Date.now() + 3600_000).toISOString();
    expect(interpretYouTubeStatus({ exists: true, uploadStatus: "processed", privacyStatus: "private", publishAt: later }).state).toBe("scheduled");
  });
  it("TikTok chunking follows the media transfer rules", () => {
    expect(chunkPlan(4 * 1024 * 1024)).toEqual({ chunkSize: 4 * 1024 * 1024, total: 1 });
    expect(chunkPlan(30 * 1024 * 1024).total).toBe(1);
    const big = chunkPlan(150 * 1024 * 1024 + 123);
    expect(big.chunkSize).toBe(10 * 1024 * 1024);
    expect(big.total).toBe(15);
    expect(choosePrivacy("PUBLIC_TO_EVERYONE", { privacy_level_options: ["SELF_ONLY"] })).toBe("SELF_ONLY");
    expect(interpretTikTokStatus({ status: "PROCESSING_UPLOAD" }).state).toBe("processing");
    expect(interpretTikTokStatus({ status: "PUBLISH_COMPLETE", publicaly_available_post_id: [123] })).toMatchObject({ state: "published", postId: "123" });
  });
  it("builds OAuth URLs with state and PKCE (Google)", async () => {
    const yt = new URL(await authorizeUrl("youtube", { clientId: "cid", clientSecret: "s", redirectUri: "https://r" }, "st", "verifier-123"));
    expect(yt.searchParams.get("state")).toBe("st");
    expect(yt.searchParams.get("code_challenge_method")).toBe("S256");
    expect(yt.searchParams.get("access_type")).toBe("offline");
    expect(yt.searchParams.get("scope")).toContain("youtube.upload");
    const tt = new URL(await authorizeUrl("tiktok", { clientId: "ck", clientSecret: "s", redirectUri: "https://r" }, "st", "v"));
    expect(tt.searchParams.get("client_key")).toBe("ck");
    expect(tt.searchParams.get("scope")).toBe("user.info.basic,video.publish");
    expect(needsRefresh({ access_token: "a", expires_at: new Date(Date.now() + 60_000).toISOString() })).toBe(true);
  });
  it("memory byte source slices", async () => {
    const s = memorySource(new Uint8Array([1, 2, 3, 4, 5]));
    expect([...(await s.read(1, 3))]).toEqual([2, 3]);
  });
});
