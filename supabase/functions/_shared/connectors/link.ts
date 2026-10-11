// Chapter pages from a link the user sends. MangaDex chapter links use the
// official API; any other site is read as plain HTML and its <img> tags are
// collected in reading order. Pages rendered only by JavaScript, behind a
// login or behind bot protection cannot be read this way — then the user
// can upload the images instead.

import { StepError } from "../core/backoff.ts";
import { type FetchLike, ensureOk, http, httpJson } from "../adapters/http.ts";
import type { PageRef } from "./types.ts";

const BROWSER_UA =
  "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36";
const MAX_IMAGES = 150;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Skip site chrome: logos, avatars, icons, ads, banners. */
const JUNK = /(logo|avatar|icon|favicon|banner|sprite|loading|spinner|placeholder|ads?[/_-]|advert|button|emoji|thumb|cover-small|\.svg|\.gif)(\?|$|[/_.-])/i;

export function isMangadexChapter(url: string): string | null {
  if (!/mangadex\.org\/chapter\//i.test(url)) return null;
  return UUID.exec(url)?.[0].toLowerCase() ?? null;
}

/** Pull image URLs from chapter HTML, in document order, without duplicates. */
export function extractImageUrls(html: string, pageUrl: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const imgTags = html.match(/<img\b[^>]*>/gi) ?? [];
  for (const tag of imgTags) {
    // lazy-loading attributes first: src is often a placeholder
    const attrs = [...tag.matchAll(/\b(data-src|data-lazy-src|data-original|data-url|src)\s*=\s*["']([^"']+)["']/gi)];
    const preferred = attrs.find((a) => a[1].toLowerCase() !== "src") ?? attrs[0];
    if (!preferred) continue;
    let raw = preferred[2].trim().split(/\s+/)[0];
    if (!raw || raw.startsWith("data:")) continue;
    raw = raw.replace(/&amp;/g, "&");
    let abs: string;
    try {
      abs = new URL(raw, pageUrl).href;
    } catch {
      continue;
    }
    if (!/^https?:/i.test(abs) || JUNK.test(abs)) continue;
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
    if (out.length >= MAX_IMAGES) break;
  }
  return out;
}

async function mangadexRefs(chapterId: string, fetchFn: FetchLike): Promise<PageRef[]> {
  const r = await httpJson<{ baseUrl: string; chapter: { hash: string; data: string[]; dataSaver: string[] } }>(
    fetchFn,
    `https://api.mangadex.org/at-home/server/${chapterId}`,
    { headers: { "user-agent": "AutoVideoShort/0.1" }, service: "MangaDex", timeoutMs: 20_000 },
  );
  const report = /mangadex\.org/.test(r.baseUrl) ? undefined : "https://api.mangadex.network/report";
  const files = r.chapter.dataSaver.length ? r.chapter.dataSaver : r.chapter.data;
  const quality = r.chapter.dataSaver.length ? "data-saver" : "data";
  return files.map((f, i) => ({
    url: `${r.baseUrl}/${quality}/${r.chapter.hash}/${f}`,
    filename: `${String(i + 1).padStart(3, "0")}-${f}`,
    reportTo: report,
  }));
}

export async function linkPageRefs(url: string, fetchFn: FetchLike): Promise<PageRef[]> {
  const md = isMangadexChapter(url);
  if (md) return mangadexRefs(md, fetchFn);

  const res = await ensureOk(
    await http(fetchFn, url, {
      headers: { "user-agent": BROWSER_UA, accept: "text/html,application/xhtml+xml", "accept-language": "pt-BR,pt;q=0.9,en;q=0.8" },
      service: "Link do capítulo",
      timeoutMs: 30_000,
    }),
    "Link do capítulo",
  );
  const html = await res.text();
  const urls = extractImageUrls(html, res.url || url);
  if (urls.length < 2) {
    throw new StepError(
      "Não encontrei as páginas nesse link (o site pode carregar as imagens por JavaScript ou bloquear leitura automática). Envie as imagens do capítulo pelo botão de arquivos.",
      "permanent",
    );
  }
  const origin = new URL(url).origin;
  return urls.map((u, i) => ({
    url: u,
    filename: `${String(i + 1).padStart(3, "0")}-${u.split("/").pop()?.split("?")[0] ?? "pagina"}`,
    // many image hosts only serve pages to requests coming from the site
    headers: { "user-agent": BROWSER_UA, referer: `${origin}/` },
  }));
}
