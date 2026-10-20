export type Subcommand =
  | "save"        // salva [indicazioni]       → propose a KB change from the thread
  | "search"      // cerca <domanda>           → answer strictly from the KB
  | "ask"         // chiedi <domanda>          → general AI answer, no KB
  | "question"    // <testo libero>            → KB when relevant, otherwise general AI
  | "collections" // collezioni [azione] [...] → manage linked Outline collections
  | "help"
  | "status"
  | "unknown";    // bare mention, nothing to do

export interface ParsedCommand {
  subcommand: Subcommand;
  /** Text after the command keyword (or the whole text for free questions). */
  args: string;
  /** Query for search/ask/question, null otherwise. */
  searchQuery: string | null;
  raw: string;
}

const KEYWORDS: Record<string, Subcommand> = {
  help: "help",
  aiuto: "help",
  status: "status",
  stato: "status",
  cerca: "search",
  search: "search",
  chiedi: "ask",
  ask: "ask",
  domanda: "ask",
  salva: "save",
  save: "save",
  collezioni: "collections",
  collezione: "collections",
  collections: "collections",
  collection: "collections",
};

function stripQuotes(s: string): string {
  return s.replace(/^["'«]|["'»]$/g, "").trim();
}

export function parseCommand(textAfterMention: string): ParsedCommand {
  const trimmed = textAfterMention.trim();

  if (trimmed === "") {
    return { subcommand: "unknown", args: "", searchQuery: null, raw: textAfterMention };
  }

  const firstToken = (trimmed.split(/\s+/)[0] ?? "").toLowerCase().replace(/[:,]$/, "");
  const keyword = KEYWORDS[firstToken];

  if (!keyword) {
    // Anything else is a free-form question to the assistant.
    return { subcommand: "question", args: trimmed, searchQuery: stripQuotes(trimmed), raw: textAfterMention };
  }

  const rest = trimmed.slice(trimmed.split(/\s+/)[0]!.length).trim();
  const searchQuery =
    keyword === "search" || keyword === "ask" ? stripQuotes(rest) : null;

  return { subcommand: keyword, args: rest, searchQuery, raw: textAfterMention };
}

export type CollectionAction =
  | { action: "list" }
  | { action: "available" }
  | { action: "add"; global: boolean; refs: string[] }
  | { action: "remove"; global: boolean; refs: string[] }
  | { action: "create"; name: string }
  | { action: "invalid"; reason: string };

const ADD = new Set(["aggiungi", "add", "collega", "link"]);
const REMOVE = new Set(["rimuovi", "remove", "scollega", "unlink", "togli"]);
const AVAILABLE = new Set(["disponibili", "available", "tutte", "all"]);
const LIST = new Set(["", "lista", "list", "elenco", "attive"]);
const CREATE = new Set(["crea", "create", "nuova", "new"]);
const GLOBAL = new Set(["globale", "global", "globali", "tutti", "--globale", "--global"]);

/** `collezioni aggiungi [globale] Clienti, Progetti` → structured action. */
export function parseCollectionArgs(args: string): CollectionAction {
  const trimmed = args.trim();
  const first = (trimmed.split(/\s+/)[0] ?? "").toLowerCase();
  let rest = trimmed.slice(first.length).trim();

  if (LIST.has(first)) return { action: "list" };
  if (AVAILABLE.has(first)) return { action: "available" };
  if (CREATE.has(first)) {
    const name = stripQuotes(rest);
    return name ? { action: "create", name } : { action: "invalid", reason: "specifica il nome della collection" };
  }

  if (ADD.has(first) || REMOVE.has(first)) {
    let global = false;
    const second = (rest.split(/\s+/)[0] ?? "").toLowerCase();
    if (GLOBAL.has(second)) {
      global = true;
      rest = rest.slice(second.length).trim();
    }
    // Comma or newline separated; names may contain spaces.
    const refs = rest
      .split(/[,\n]/)
      .map((r) => stripQuotes(r.trim()))
      .filter(Boolean);
    if (refs.length === 0) return { action: "invalid", reason: "specifica almeno una collection (nome, URL o ID)" };
    return { action: ADD.has(first) ? "add" : "remove", global, refs };
  }

  return { action: "invalid", reason: `azione sconosciuta "${first}"` };
}

export type ProposalReply =
  | { kind: "approve" }
  | { kind: "cancel" }
  | { kind: "retarget_doc"; ref: string }
  | { kind: "retarget_collection"; ref: string }
  | { kind: "retarget_parent"; ref: string }
  | { kind: "rename"; title: string }
  | { kind: "instructions"; text: string };

/**
 * Replies in a thread with a pending proposal. Short approval/cancel words must
 * be the whole message so ordinary discussion ("no, secondo me…") is not
 * mistaken for a decision; the other forms require an explicit "keyword:" prefix.
 */
export function parseProposalReply(text: string): ProposalReply | null {
  const t = text.trim();
  if (/^(ok|okay|sì|si|yes|conferma|confermo|approva|approvo|applica|procedi|vai)[.!\s]*$/i.test(t)) {
    return { kind: "approve" };
  }
  if (/^(annulla|no|cancel|rifiuta|stop|lascia perdere)[.!\s]*$/i.test(t)) return { kind: "cancel" };

  const m = /^([a-zà-ù]+)\s*:\s*([\s\S]+)$/i.exec(t);
  if (!m) return null;
  const key = m[1]!.toLowerCase();
  const value = m[2]!.trim();
  if (!value) return null;
  if (key === "doc" || key === "documento" || key === "document") return { kind: "retarget_doc", ref: value };
  if (key === "collezione" || key === "collection") return { kind: "retarget_collection", ref: value };
  if (key === "sotto" || key === "parent" || key === "dentro") return { kind: "retarget_parent", ref: value };
  if (key === "titolo" || key === "title") return { kind: "rename", title: stripQuotes(value) };
  if (key === "nota" || key === "note" || key === "istruzioni" || key === "modifica") {
    return { kind: "instructions", text: value };
  }
  return null;
}
