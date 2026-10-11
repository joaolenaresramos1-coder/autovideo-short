import type { Work } from "../core/types.ts";
import { mangadex } from "./mangadex.ts";
import { anilist, manual, rss, upload } from "./others.ts";
import type { Connector } from "./types.ts";

const link: Connector = { ...upload, id: "link", label: "Links de capítulos enviados por mim" };

export const CONNECTORS: Record<Work["source"], Connector> = { mangadex, rss, anilist, upload, manual, link };

export function connectorFor(work: Pick<Work, "source">): Connector {
  return CONNECTORS[work.source] ?? manual;
}

/** Guess the best connector from a pasted link. */
export function detectSource(url: string | null | undefined): Work["source"] {
  if (!url) return "manual";
  if (/mangadex\.org\/title\//i.test(url)) return "mangadex";
  if (/anilist\.co\/anime\//i.test(url)) return "anilist";
  if (/(\.xml|\.rss|\/feed\/?|\/rss\/?|atom)(\?|$)/i.test(url)) return "rss";
  return "manual";
}

export type { Connector } from "./types.ts";
