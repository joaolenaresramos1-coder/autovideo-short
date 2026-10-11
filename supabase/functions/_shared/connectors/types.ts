import type { FetchLike } from "../adapters/http.ts";
import type { Work } from "../core/types.ts";

export interface ChapterInfo {
  key: string;
  number: number | null;
  title: string | null;
  sourceId: string | null;
  url: string | null;
  publishedAt: string | null;
  pageCount?: number | null;
}

export interface PageRef {
  url: string;
  filename: string;
  /** MangaDex@Home asks clients to report every image load. */
  reportTo?: string;
  headers?: Record<string, string>;
}

export interface SourceCheck {
  /** Work status that results from the check. */
  status: "active" | "pending_config" | "error";
  reason: string;
  /** Whether chapter material (pages) can be fetched automatically. */
  canFetchPages: boolean;
  sourceRef?: string;
  title?: string;
}

export interface Connector {
  id: Work["source"];
  label: string;
  /** Detects new chapters/episodes automatically. */
  detectsChapters: boolean;
  check(work: Work, fetchFn: FetchLike): Promise<SourceCheck>;
  listChapters(work: Work, fetchFn: FetchLike): Promise<ChapterInfo[]>;
  /** Only called when the work's reuse authorization is confirmed. */
  pageRefs?(work: Work, chapter: { source_chapter_id: string | null; chapter_key: string }, fetchFn: FetchLike): Promise<PageRef[]>;
}

export const USER_AGENT = "AutoVideoShort/0.1 (+https://github.com/joaolenaresramos1-coder/autovideo-short)";

/** Extract a chapter/episode number from a title like "Capítulo 12.5". */
export function chapterNumberFrom(text: string): number | null {
  const m = /(?:cap[ií]tulo|chapter|chap\.?|ch\.?|cap\.?|ep(?:is[oó]dio|isode)?\.?|#)\s*(\d+(?:[.,]\d+)?)/i.exec(text) ??
    /(\d+(?:[.,]\d+)?)\s*$/.exec(text.trim());
  return m ? Number(m[1].replace(",", ".")) : null;
}
