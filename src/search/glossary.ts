import { config } from "../config.js";
import { db } from "../db/index.js";

/**
 * Acronyms and synonyms ("AHRW" = "Ad hoc Revolution Web"). When a question
 * uses one form, the search also looks for the others, and the answer model
 * is told what the acronym means. Entries come from SEARCH_GLOSSARY (.env)
 * and from chat (`@bot glossario aggiungi …`, stored in the database).
 */
export interface GlossaryEntry {
  /** Equivalent forms; the first is the key shown in chat. */
  aliases: string[];
  source: "env" | "chat";
}

const SETTINGS_KEY = "search_glossary";
const getStmt = db.prepare<[string], { value: string }>("SELECT value FROM bot_settings WHERE key = ?");
const setStmt = db.prepare(
  "INSERT INTO bot_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
);

/** Lowercase, accents removed, whitespace collapsed (mirrors FTS5 remove_diacritics). */
export function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Parses "AHRW = Ad hoc Revolution Web | AHR Web" into its aliases. */
export function parseGlossaryDefinition(def: string): string[] | null {
  const eq = def.indexOf("=");
  if (eq < 0) return null;
  const aliases = [def.slice(0, eq), ...def.slice(eq + 1).split("|")]
    .map((a) => a.trim().replace(/^["'«]|["'»]$/g, "").trim())
    .filter((a) => a && !a.includes("="));
  const unique = [...new Map(aliases.map((a) => [normalize(a), a])).values()];
  return unique.length >= 2 ? unique : null;
}

/**
 * Several definitions at once, separated by ";" or new lines. A "|" segment
 * containing "=" starts a new definition, so
 * "AHRW = Ad hoc Revolution Web | G1 = Gestionale 1" yields two entries.
 */
export function parseGlossaryDefinitions(text: string): string[][] {
  const defs: string[] = [];
  for (const part of text.split(/[;\n]/)) {
    let current = "";
    for (const seg of part.split("|")) {
      if (seg.includes("=") && current.includes("=")) {
        defs.push(current);
        current = seg;
      } else {
        current = current ? `${current}|${seg}` : seg;
      }
    }
    if (current.trim()) defs.push(current);
  }
  return defs.map((d) => parseGlossaryDefinition(d)).filter((a): a is string[] => a !== null);
}

function envEntries(): GlossaryEntry[] {
  return parseGlossaryDefinitions(config.SEARCH_GLOSSARY).map((aliases) => ({ aliases, source: "env" as const }));
}

function chatEntries(): GlossaryEntry[] {
  const raw = getStmt.get(SETTINGS_KEY)?.value;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as string[][];
    return parsed
      .filter((a) => Array.isArray(a) && a.length >= 2)
      // Repair entries saved before multi-definition parsing ("X = Y | Z = W" stored as one).
      .flatMap((a) => (a.some((x) => x.includes("=")) ? parseGlossaryDefinitions(`${a[0]} = ${a.slice(1).join("|")}`) : [a]))
      .map((aliases) => ({ aliases, source: "chat" as const }));
  } catch {
    return [];
  }
}

function saveChatEntries(entries: GlossaryEntry[]): void {
  setStmt.run(SETTINGS_KEY, JSON.stringify(entries.map((e) => e.aliases)));
}

export function listGlossary(): GlossaryEntry[] {
  return [...envEntries(), ...chatEntries()];
}

/** Adds (or replaces, matched by any alias) a chat-defined entry. */
export function addGlossaryEntry(aliases: string[]): { replaced: boolean } {
  const keys = new Set(aliases.map(normalize));
  const current = chatEntries();
  const kept = current.filter((e) => !e.aliases.some((a) => keys.has(normalize(a))));
  saveChatEntries([...kept, { aliases, source: "chat" }]);
  return { replaced: kept.length !== current.length };
}

/** Removes the chat-defined entry containing `alias`. Env entries can't be removed from chat. */
export function removeGlossaryEntry(alias: string): "removed" | "env" | "missing" {
  const key = normalize(alias);
  const current = chatEntries();
  const kept = current.filter((e) => !e.aliases.some((a) => normalize(a) === key));
  if (kept.length !== current.length) {
    saveChatEntries(kept);
    return "removed";
  }
  return envEntries().some((e) => e.aliases.some((a) => normalize(a) === key)) ? "env" : "missing";
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when `phrase` occurs in `text` as whole words (both already normalized). */
export function containsPhrase(text: string, phrase: string): boolean {
  if (!phrase) return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegex(phrase)}($|[^\\p{L}\\p{N}])`, "u").test(text);
}

export interface QueryExpansion {
  /** Glossary entries mentioned in the query (by any alias). */
  matched: GlossaryEntry[];
  /** Query text for the embedding, with the other aliases appended. */
  embeddingQuery: string;
  /** Short note for the answer model, e.g. "AHRW = Ad hoc Revolution Web". */
  note: string;
}

export function expandQuery(query: string, entries: GlossaryEntry[] = listGlossary()): QueryExpansion {
  const q = normalize(query);
  const matched = entries.filter((e) => e.aliases.some((a) => containsPhrase(q, normalize(a))));
  const extra = matched.flatMap((e) => e.aliases.filter((a) => !containsPhrase(q, normalize(a))));
  return {
    matched,
    embeddingQuery: extra.length > 0 ? `${query} (${extra.join(", ")})` : query,
    note: matched.map((e) => e.aliases.join(" = ")).join("; "),
  };
}
