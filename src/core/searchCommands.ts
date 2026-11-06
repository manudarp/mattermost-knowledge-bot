import type { OutlineClient } from "../outline/client.js";
import type { Logger } from "../logger.js";
import { config } from "../config.js";
import { parseGlossaryArgs } from "./commandParser.js";
import { isAdmin } from "./collectionCommands.js";
import { getEffectiveCollections } from "./collectionScope.js";
import {
  addGlossaryEntry,
  listGlossary,
  parseGlossaryDefinition,
  removeGlossaryEntry,
} from "../search/glossary.js";
import { searchWithTrace, type SearchTrace } from "../search/retrieval.js";

export function glossaryHelp(): string {
  const bot = `@${config.MM_BOT_USERNAME}`;
  return `**Glossario (sigle e sinonimi per la ricerca)**
• \`${bot} glossario\` — elenco
• \`${bot} glossario aggiungi AHRW = Ad hoc Revolution Web\` — più alternative con \`|\`: \`G1 = Gestionale 1 | Gestionale uno\`
• \`${bot} glossario rimuovi AHRW\`
• \`${bot} debug <domanda>\` — mostra quali passaggi trova la ricerca e perché`;
}

/** Handles `@bot glossario …` and returns the reply. */
export function handleGlossaryCommand(opts: { args: string; username: string }): string {
  const action = parseGlossaryArgs(opts.args);
  const bot = `@${config.MM_BOT_USERNAME}`;

  if (action.action === "invalid") return `⚠️ ${action.reason}.\n\n${glossaryHelp()}`;

  if (action.action === "list") {
    const entries = listGlossary();
    if (entries.length === 0) {
      return `📖 Il glossario è vuoto.\nAggiungi una sigla con \`${bot} glossario aggiungi AHRW = Ad hoc Revolution Web\`.`;
    }
    const lines = entries.map((e) => `• **${e.aliases[0]}** = ${e.aliases.slice(1).join(" | ")}${e.source === "env" ? " _(da .env)_" : ""}`);
    return `📖 **Glossario** — quando una domanda usa una forma, cerco anche le altre:\n${lines.join("\n")}`;
  }

  if (!isAdmin(opts.username)) {
    return "⛔ Solo gli amministratori del bot (`BOT_ADMINS`) possono modificare il glossario.";
  }

  if (action.action === "add") {
    const aliases = parseGlossaryDefinition(action.definition);
    if (!aliases) return "⚠️ Servono almeno due forme diverse, es. `AHRW = Ad hoc Revolution Web`.";
    const { replaced } = addGlossaryEntry(aliases);
    return `✅ ${replaced ? "Aggiornato" : "Aggiunto"}: **${aliases[0]}** = ${aliases.slice(1).join(" | ")}`;
  }

  const outcome = removeGlossaryEntry(action.term);
  if (outcome === "removed") return `🗑️ Rimosso **${action.term}** dal glossario.`;
  if (outcome === "env") return `ℹ️ **${action.term}** è definito in \`SEARCH_GLOSSARY\` (.env): va rimosso da lì.`;
  return `⚠️ **${action.term}** non è nel glossario.`;
}

function fmt(n: number): string {
  return n.toFixed(2);
}

function cell(s: string, max = 70): string {
  const t = s.replace(/\s+/g, " ").replace(/\|/g, "/");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function renderTrace(trace: SearchTrace, scopeLabel: string): string {
  const out: string[] = [`🔎 **Debug ricerca:** _${trace.query}_`, `Ambito: ${scopeLabel}`];
  if (trace.glossaryNote) out.push(`Glossario applicato: ${trace.glossaryNote}`);
  out.push(`Parole chiave cercate: \`${trace.fts ?? "nessuna"}\``);
  out.push(
    trace.semantic
      ? `Similarità semantica: migliore ${fmt(trace.topScore)} · soglia ${fmt(trace.minScore)} · margine ${fmt(config.SEARCH_RELATIVE_MARGIN)} → passano i passaggi ≥ **${fmt(trace.semanticFloor)}**`
      : "⚠️ Embedding non disponibile: solo ricerca per parole chiave.",
  );
  out.push(
    trace.rerank === "ok"
      ? `Riordino AI: attivo, tengo i passaggi con voto ≥ ${config.SEARCH_RERANK_MIN_SCORE} (3 = risponde, 2 = utile, 1 = marginale, 0 = fuori tema)`
      : trace.rerank === "failed"
        ? `Riordino AI: **fallito** (${cell(trace.rerankError ?? "", 150)}), uso l'ordine della ricerca`
        : "Riordino AI: disattivato",
  );

  if (trace.candidates.length === 0) {
    out.push("\nNessun passaggio trovato.");
    return out.join("\n");
  }

  out.push("", "| | Documento › sezione | Sem. | Parole chiave | Esito | AI |", "|---|---|---|---|---|---|");
  trace.candidates.forEach((c, i) => {
    const kw = c.keywordRank !== null ? `#${c.keywordRank} (${Math.round(c.coverage * 100)}%)` : "—";
    const title = c.heading && c.heading !== c.docTitle ? `${c.docTitle} › ${c.heading}` : c.docTitle;
    out.push(
      `| ${c.selected ? "✅" : i + 1} | ${cell(title)} | ${trace.semantic ? fmt(c.score) : "—"} | ${kw} | ${c.passed ? c.verdict : `❌ ${c.verdict}`} | ${c.rerankScore ?? "—"} |`,
    );
  });
  out.push("", "✅ = passaggi passati alla risposta. _Parole chiave_: posizione e % dei termini della domanda presenti.");
  return out.join("\n");
}

/** Handles `@bot debug <domanda>`: runs the same search as a question and explains it. */
export async function handleDebugCommand(opts: {
  query: string;
  channelId: string;
  ctx: { outlineClient: OutlineClient; logger: Logger };
}): Promise<string> {
  if (!opts.query) return `Uso: \`@${config.MM_BOT_USERNAME} debug <domanda>\``;
  const collections = await getEffectiveCollections(opts.ctx.outlineClient, opts.ctx.logger, opts.channelId);
  const scope = collections.length > 0 ? { collectionIds: collections.map((c) => c.id) } : undefined;
  const { trace } = await searchWithTrace(opts.query, config.SEARCH_TOP_K, scope);
  const label = collections.length > 0 ? collections.map((c) => c.name).join(", ") : "tutta la wiki";
  return renderTrace(trace, label);
}
