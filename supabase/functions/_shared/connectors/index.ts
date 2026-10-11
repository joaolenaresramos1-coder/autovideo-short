import type { Work } from "../core/types.ts";
import { mangadex } from "./mangadex.ts";
import { anilist, manual, rss, upload } from "./others.ts";
import { link } from "./link.ts";
import type { Connector } from "./types.ts";

export const CONNECTORS: Record<Work["source"], Connector> = { mangadex, rss, anilist, upload, manual, link };

export function connectorFor(work: Pick<Work, "source">): Connector {
  return CONNECTORS[work.source] ?? manual;
}

/** Pick the connector from a pasted link: any other website works as "link". */
export function detectSource(url: string | null | undefined): Work["source"] {
  if (!url?.trim()) return "upload";
  if (/mangadex\.org\/title\//i.test(url)) return "mangadex";
  if (/anilist\.co\/anime\//i.test(url)) return "anilist";
  if (/(\.xml|\.rss|\/feed\/?|\/rss\/?|atom)(\?|$)/i.test(url)) return "rss";
  return /^https?:\/\//i.test(url.trim()) ? "link" : "upload";
}

export type { Connector } from "./types.ts";
