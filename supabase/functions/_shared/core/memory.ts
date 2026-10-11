// Narrative memory: characters, relations, powers, events and continuity
// points, each tagged as a confirmed fact, an interpretation or a theory.

import type { Certainty, MemoryKind } from "./types.ts";

export interface MemoryEntry {
  kind: MemoryKind;
  name: string;
  content: string;
  certainty: Certainty;
  first_chapter_key?: string | null;
  updated_chapter_key?: string | null;
  superseded?: boolean;
}

export interface MemoryUpdate {
  kind: MemoryKind;
  name: string;
  content: string;
  certainty: Certainty;
  /** true when the chapter shows the previous fact is no longer valid. */
  supersedes?: boolean;
}

const RANK: Record<Certainty, number> = { theory: 0, interpretation: 1, confirmed: 2 };
const KINDS: MemoryKind[] = ["character", "relationship", "power", "event", "continuity", "location", "item", "theme"];

export function memoryKey(kind: string, name: string): string {
  return `${kind}:${name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim()}`;
}

/**
 * Merge updates into memory. A lower-certainty statement never overwrites a
 * higher-certainty one (a theory cannot replace a confirmed fact), unless the
 * chapter explicitly confirms a change (`supersedes` + confirmed).
 */
export function mergeMemory(
  existing: MemoryEntry[],
  updates: MemoryUpdate[],
  chapterKey: string,
): { upserts: MemoryEntry[]; rejected: { update: MemoryUpdate; reason: string }[] } {
  const map = new Map(existing.map((e) => [memoryKey(e.kind, e.name), e]));
  const upserts = new Map<string, MemoryEntry>();
  const rejected: { update: MemoryUpdate; reason: string }[] = [];
  for (const u of updates) {
    if (!KINDS.includes(u.kind) || !u.name?.trim() || !u.content?.trim()) {
      rejected.push({ update: u, reason: "entrada incompleta" });
      continue;
    }
    if (!(u.certainty in RANK)) {
      rejected.push({ update: u, reason: "certeza inválida" });
      continue;
    }
    const key = memoryKey(u.kind, u.name);
    const cur = upserts.get(key) ?? map.get(key);
    const content = u.content.trim().slice(0, 4000);
    if (!cur) {
      upserts.set(key, {
        kind: u.kind,
        name: u.name.trim().slice(0, 200),
        content,
        certainty: u.certainty,
        first_chapter_key: chapterKey,
        updated_chapter_key: chapterKey,
        superseded: false,
      });
      continue;
    }
    const replaces = RANK[u.certainty] > RANK[cur.certainty] ||
      (RANK[u.certainty] === RANK[cur.certainty]) ||
      (u.supersedes === true && u.certainty === "confirmed");
    if (!replaces) {
      rejected.push({ update: u, reason: `não substitui um registro "${cur.certainty}"` });
      continue;
    }
    upserts.set(key, { ...cur, content, certainty: u.certainty, updated_chapter_key: chapterKey, superseded: false });
  }
  return { upserts: [...upserts.values()], rejected };
}

const LABEL: Record<Certainty, string> = {
  confirmed: "FATO",
  interpretation: "INTERPRETAÇÃO",
  theory: "TEORIA",
};

/** Compact text block for prompts, most certain entries first, bounded size. */
export function memoryContext(entries: MemoryEntry[], maxChars = 12000): string {
  const active = entries.filter((e) => !e.superseded);
  const lines: string[] = [];
  for (const kind of KINDS) {
    const group = active
      .filter((e) => e.kind === kind)
      .sort((a, b) => RANK[b.certainty] - RANK[a.certainty]);
    if (group.length === 0) continue;
    lines.push(`## ${kind}`);
    for (const e of group) lines.push(`- [${LABEL[e.certainty]}] ${e.name}: ${e.content}`);
  }
  let text = lines.join("\n");
  if (text.length > maxChars) text = text.slice(0, maxChars) + "\n…(memória truncada)";
  return text || "(sem memória registrada ainda)";
}
