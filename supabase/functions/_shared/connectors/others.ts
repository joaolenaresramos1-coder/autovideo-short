// RSS/Atom feeds (official publisher feeds), AniList (anime episodes),
// manual uploads and "manual" works without a source.

import { StepError } from "../core/backoff.ts";
import { type FetchLike, ensureOk, http, httpJson } from "../adapters/http.ts";
import { type ChapterInfo, type Connector, chapterNumberFrom, USER_AGENT } from "./types.ts";

function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&")
    .trim();
}

function tag(xml: string, name: string): string | null {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(xml);
  return m ? decodeXml(m[1]) : null;
}

/** Parses RSS 2.0 <item> and Atom <entry> elements. */
export function parseFeed(xml: string): ChapterInfo[] {
  const items = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];
  const out: ChapterInfo[] = [];
  for (const it of items) {
    const title = tag(it, "title") ?? "";
    const link = tag(it, "link") ?? /<link[^>]*href="([^"]+)"/i.exec(it)?.[1] ?? null;
    const id = tag(it, "guid") ?? tag(it, "id") ?? link ?? title;
    const date = tag(it, "pubDate") ?? tag(it, "updated") ?? tag(it, "published");
    const number = chapterNumberFrom(title);
    const parsedDate = date ? new Date(date) : null;
    out.push({
      key: number !== null ? String(number) : `item-${id.slice(-40)}`,
      number,
      title: title || null,
      sourceId: id,
      url: link ? decodeXml(link) : null,
      publishedAt: parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate.toISOString() : null,
    });
  }
  return out;
}

export const rss: Connector = {
  id: "rss",
  label: "Feed RSS/Atom",
  detectsChapters: true,
  async check(work, fetchFn) {
    if (!work.url) return { status: "pending_config", reason: "Informe a URL do feed RSS/Atom", canFetchPages: false };
    try {
      const res = await ensureOk(await http(fetchFn, work.url, { headers: { "user-agent": USER_AGENT }, service: "Feed", timeoutMs: 20_000 }), "Feed");
      const items = parseFeed(await res.text());
      if (items.length === 0) return { status: "error", reason: "O endereço não contém itens RSS/Atom", canFetchPages: false };
      return {
        status: "active",
        reason: `Feed com ${items.length} itens. O feed só informa novos capítulos: envie o material autorizado de cada capítulo para gerar o vídeo.`,
        canFetchPages: false,
      };
    } catch (e) {
      return { status: "error", reason: `Feed inacessível: ${(e as Error).message}`, canFetchPages: false };
    }
  },
  async listChapters(work, fetchFn) {
    if (!work.url) throw new StepError("Obra sem URL de feed", "config");
    const res = await ensureOk(await http(fetchFn, work.url, { headers: { "user-agent": USER_AGENT }, service: "Feed", timeoutMs: 20_000 }), "Feed");
    return parseFeed(await res.text());
  },
};

export function anilistId(work: { source_ref: string | null; url: string | null }): number | null {
  const src = work.source_ref ?? work.url ?? "";
  const m = /anilist\.co\/anime\/(\d+)/i.exec(src) ?? /^(\d+)$/.exec(src.trim());
  return m ? Number(m[1]) : null;
}

const ANILIST_QUERY = `query ($id: Int) {
  Media(id: $id, type: ANIME) {
    title { romaji english }
    episodes
    status
    airingSchedule(notYetAired: false, perPage: 50) { nodes { episode airingAt } }
  }
}`;

interface AniListMedia {
  title: { romaji?: string; english?: string };
  episodes: number | null;
  status: string;
  airingSchedule: { nodes: { episode: number; airingAt: number }[] };
}

async function fetchAniListMedia(id: number, fetchFn: FetchLike): Promise<AniListMedia> {
  const r = await httpJson<{ data?: { Media?: AniListMedia }; errors?: { message: string }[] }>(fetchFn, "https://graphql.anilist.co", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ query: ANILIST_QUERY, variables: { id } }),
    service: "AniList",
    timeoutMs: 20_000,
  });
  if (!r.data?.Media) throw new StepError(`AniList: ${r.errors?.[0]?.message ?? "anime não encontrado"}`, "permanent");
  return r.data.Media;
}

export const anilist: Connector = {
  id: "anilist",
  label: "AniList (episódios de anime)",
  detectsChapters: true,
  async check(work, fetchFn) {
    const id = anilistId(work);
    if (!id) return { status: "pending_config", reason: "Informe o link do anime no AniList (anilist.co/anime/<id>)", canFetchPages: false };
    try {
      const m = await fetchAniListMedia(id, fetchFn);
      return {
        status: "active",
        reason: "Episódios detectados pelo AniList. O AniList não fornece o conteúdo: envie legendas/roteiro autorizados de cada episódio.",
        canFetchPages: false,
        sourceRef: String(id),
        title: m.title.english ?? m.title.romaji,
      };
    } catch (e) {
      return { status: "error", reason: `AniList indisponível: ${(e as Error).message}`, canFetchPages: false };
    }
  },
  async listChapters(work, fetchFn) {
    const id = anilistId(work);
    if (!id) throw new StepError("Obra sem ID do AniList", "config");
    const m = await fetchAniListMedia(id, fetchFn);
    const aired = m.airingSchedule.nodes.length
      ? m.airingSchedule.nodes
      : m.status === "FINISHED" && m.episodes
        ? Array.from({ length: m.episodes }, (_, i) => ({ episode: i + 1, airingAt: 0 }))
        : [];
    return aired.map((n) => ({
      key: `ep-${n.episode}`,
      number: n.episode,
      title: `Episódio ${n.episode}`,
      sourceId: `${id}:${n.episode}`,
      url: `https://anilist.co/anime/${id}`,
      publishedAt: n.airingAt ? new Date(n.airingAt * 1000).toISOString() : null,
    }));
  },
};

export const upload: Connector = {
  id: "upload",
  label: "Envio manual de material autorizado",
  detectsChapters: false,
  async check() {
    return {
      status: "active",
      reason: "Envie as páginas (ou o link) de cada capítulo pela tela da obra ou em Gerar vídeo.",
      canFetchPages: true,
    };
  },
  async listChapters() {
    return []; // chapters are created when the user uploads material
  },
};

export const manual: Connector = {
  id: "manual",
  label: "Sem fonte automática",
  detectsChapters: false,
  async check() {
    return {
      status: "pending_config",
      reason: "Esta obra não tem fonte compatível com detecção automática. Escolha MangaDex, RSS, AniList ou envio manual.",
      canFetchPages: false,
    };
  },
  async listChapters() {
    return [];
  },
};
