// MangaDex public API (https://api.mangadex.org/docs). Chapter detection uses
// the official feed endpoint. Pages are fetched through the official
// at-home endpoint ONLY when the user confirmed reuse authorization for the
// work, and every image load is reported as MangaDex requires.

import { StepError } from "../core/backoff.ts";
import type { Work } from "../core/types.ts";
import { type FetchLike, httpJson } from "../adapters/http.ts";
import { type ChapterInfo, type Connector, type PageRef, USER_AGENT } from "./types.ts";

const API = "https://api.mangadex.org";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export function mangadexId(work: Pick<Work, "source_ref" | "url">): string | null {
  if (work.source_ref && UUID.test(work.source_ref)) return UUID.exec(work.source_ref)![0].toLowerCase();
  if (work.url && /mangadex\.org/i.test(work.url)) {
    const m = UUID.exec(work.url);
    return m ? m[0].toLowerCase() : null;
  }
  return null;
}

/** "pt-BR" -> "pt-br", "en" -> "en" (MangaDex language codes). */
export function mdLanguage(lang: string): string {
  const l = lang.toLowerCase();
  if (l === "pt" || l === "pt-br") return "pt-br";
  if (l === "es-la" || l === "es-419") return "es-la";
  return l.split("-")[0];
}

const headers = { "user-agent": USER_AGENT, accept: "application/json" };

interface FeedResponse {
  data: {
    id: string;
    attributes: {
      chapter: string | null;
      title: string | null;
      pages: number;
      publishAt: string;
      externalUrl: string | null;
      translatedLanguage: string;
    };
  }[];
  total: number;
  limit: number;
  offset: number;
}

export const mangadex: Connector = {
  id: "mangadex",
  label: "MangaDex (API oficial)",
  detectsChapters: true,

  async check(work, fetchFn) {
    const id = mangadexId(work);
    if (!id) {
      return { status: "pending_config", reason: "Informe o link da obra no MangaDex (mangadex.org/title/<id>)", canFetchPages: false };
    }
    try {
      const r = await httpJson<{ data: { attributes: { title: Record<string, string> } } }>(
        fetchFn, `${API}/manga/${id}`, { headers, service: "MangaDex", timeoutMs: 20_000 },
      );
      const title = Object.values(r.data.attributes.title)[0];
      return {
        status: "active",
        reason: "Fonte verificada. Capítulos detectados e páginas obtidas pela API do MangaDex.",
        canFetchPages: true,
        sourceRef: id,
        title,
      };
    } catch (e) {
      return { status: "error", reason: `MangaDex indisponível ou obra inexistente: ${(e as Error).message}`, canFetchPages: false, sourceRef: id };
    }
  },

  async listChapters(work, fetchFn) {
    const id = mangadexId(work);
    if (!id) throw new StepError("Obra sem ID do MangaDex", "config");
    const lang = mdLanguage(work.language);
    const out = new Map<string, ChapterInfo>();
    for (let offset = 0; offset < 5000; offset += 500) {
      const q = new URLSearchParams({
        limit: "500",
        offset: String(offset),
        "translatedLanguage[]": lang,
        "order[chapter]": "asc",
        includeExternalUrl: "0",
        includeFutureUpdates: "0",
      });
      const r = await httpJson<FeedResponse>(fetchFn, `${API}/manga/${id}/feed?${q}`, { headers, service: "MangaDex", timeoutMs: 30_000 });
      for (const c of r.data) {
        const a = c.attributes;
        if (a.externalUrl || !a.pages) continue; // hosted elsewhere: no pages via API
        const key = a.chapter ?? `oneshot-${c.id.slice(0, 8)}`;
        if (out.has(key)) continue; // several groups may upload the same chapter
        out.set(key, {
          key,
          number: a.chapter !== null && !Number.isNaN(Number(a.chapter)) ? Number(a.chapter) : null,
          title: a.title,
          sourceId: c.id,
          url: `https://mangadex.org/chapter/${c.id}`,
          publishedAt: a.publishAt,
          pageCount: a.pages,
        });
      }
      if (r.offset + r.limit >= r.total) break;
    }
    return [...out.values()];
  },

  async pageRefs(work, chapter, fetchFn) {
    if (!chapter.source_chapter_id) throw new StepError("Capítulo sem ID do MangaDex", "permanent");
    const r = await httpJson<{ baseUrl: string; chapter: { hash: string; data: string[]; dataSaver: string[] } }>(
      fetchFn, `${API}/at-home/server/${chapter.source_chapter_id}`, { headers, service: "MangaDex", timeoutMs: 20_000 },
    );
    const report = /mangadex\.org/.test(r.baseUrl) ? undefined : "https://api.mangadex.network/report";
    // data-saver keeps files small (enough for 1080p vertical video).
    const files = r.chapter.dataSaver.length ? r.chapter.dataSaver : r.chapter.data;
    const quality = r.chapter.dataSaver.length ? "data-saver" : "data";
    return files.map((f, i): PageRef => ({
      url: `${r.baseUrl}/${quality}/${r.chapter.hash}/${f}`,
      filename: `${String(i + 1).padStart(3, "0")}-${f}`,
      reportTo: report,
      headers: { "user-agent": USER_AGENT },
    }));
  },
};
