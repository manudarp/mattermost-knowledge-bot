import type { OutlineClient } from "../outline/client.js";
import type { Logger } from "../logger.js";
import { config } from "../config.js";
import { parseGlossaryArgs } from "./commandParser.js";
import { isAdmin } from "./collectionCommands.js";
import { getEffectiveCollections } from "./collectionScope.js";
import {
  addGlossaryEntry,
  listGlossary,
  parseGlossaryDefinitions,
  removeGlossaryEntry,
} from "../search/glossary.js";
import { searchWithTrace, type SearchTrace } from "../search/retrieval.js";
import { rerankThreshold } from "../search/rerank.js";

export function glossaryHelp(): string {
  const bot = `@${config.MM_BOT_USERNAME}`;
  return `**Glossario (sigle e sinonimi per la ricerca)**
• \`${bot} glossario\` — elenco
• \`${bot} glossario aggiungi AHRW = Ad hoc Revolution Web\` — più alternative con \`|\` (\`G1 = Gestionale 1 | Gestionale uno\`); più sigle insieme: \`AHRW = Ad hoc Revolution Web; G1 = Gestionale 1\`
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
    const definitions = parseGlossaryDefinitions(action.definition);
    if (definitions.length === 0) return "⚠️ Servono almeno due forme diverse, es. `AHRW = Ad hoc Revolution Web`.";
    const lines = definitions.map((aliases) => {
      const { replaced } = addGlossaryEntry(aliases);
      return `✅ ${replaced ? "Aggiornato" : "Aggiunto"}: **${aliases[0]}** = ${aliases.slice(1).join(" | ")}`;
    });
    return lines.join("\n");
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
  const split = trace.passes.length > 1;
  if (split) {
    out.push(`La domanda contiene più richieste: faccio **${trace.passes.length} ricerche separate** e unisco i risultati.`);
  } else if (trace.decomposition === "single" && trace.passes[0] && trace.passes[0].query !== trace.query) {
    out.push(`Domanda riscritta usando la conversazione: _${cell(trace.passes[0].query, 200)}_`);
  } else if (trace.decomposition === "failed") {
    out.push(`⚠️ Scomposizione della domanda fallita (${cell(trace.decompositionError ?? "", 150)}): faccio una ricerca unica.`);
  }
  for (const p of trace.passes) {
    const prefix = split ? `**Ricerca ${p.label}:** _${cell(p.query, 150)}_ — ` : "";
    out.push(`${prefix}Parole chiave cercate: \`${p.fts ?? "nessuna"}\``);
    out.push(
      trace.semantic
        ? `${split ? "  " : ""}Similarità semantica: migliore ${fmt(p.topScore)} · soglia ${fmt(trace.minScore)} · margine ${fmt(config.SEARCH_RELATIVE_MARGIN)} → passano i passaggi ≥ **${fmt(p.semanticFloor)}**`
        : "⚠️ Embedding non disponibile: solo ricerca per parole chiave.",
    );
  }
  out.push(
    trace.rerank === "ok"
      ? config.SEARCH_RERANK_PROVIDER === "api"
        ? `Riordino: reranker \`${config.RERANK_MODEL || config.RERANK_BASE_URL}\`, tengo i passaggi con punteggio ≥ ${rerankThreshold()} (da 0 a 1)`
        : `Riordino AI: attivo, tengo i passaggi con voto ≥ ${rerankThreshold()} (3 = risponde, 2 = utile, 1 = marginale, 0 = fuori tema)`
      : trace.rerank === "failed"
        ? `Riordino AI: **fallito** (${cell(trace.rerankError ?? "", 150)}), uso l'ordine della ricerca`
        : "Riordino AI: disattivato",
  );

  if (trace.candidates.length === 0) {
    out.push("\nNessun passaggio trovato.");
    return out.join("\n");
  }

  out.push(
    "",
    `| | Documento › sezione |${split ? " Ricerca |" : ""} Sem. | Parole chiave | Esito | AI |`,
    `|---|---|${split ? "---|" : ""}---|---|---|---|`,
  );
  trace.candidates.forEach((c, i) => {
    const kw = c.keywordRank !== null ? `#${c.keywordRank} (${Math.round(c.coverage * 100)}%)` : "—";
    const title = c.heading && c.heading !== c.docTitle ? `${c.docTitle} › ${c.heading}` : c.docTitle;
    const ai = c.rerankScore === null ? "—" : Number.isInteger(c.rerankScore) ? String(c.rerankScore) : c.rerankScore.toFixed(2);
    out.push(
      `| ${c.selected ? "✅" : i + 1} | ${cell(title)} |${split ? ` ${c.via ?? ""} |` : ""} ${trace.semantic ? fmt(c.score) : "—"} | ${kw} | ${c.passed ? c.verdict : `❌ ${c.verdict}`} | ${ai} |`,
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
