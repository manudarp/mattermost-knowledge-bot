import type { OutlineClient } from "../outline/client.js";
import type { Logger } from "../logger.js";
import { config } from "../config.js";
import { parseIndexArgs } from "./commandParser.js";
import { isAdmin } from "./collectionCommands.js";
import { getEffectiveCollections } from "./collectionScope.js";
import { documentRefFromText, documentUrl } from "../outline/documents.js";
import { listCollections } from "../outline/collections.js";
import {
  currentSyncProgress,
  indexSingleDocument,
  indexStats,
  lastSyncResult,
  runFullSync,
  type SyncStats,
} from "../indexer/outlineIndexer.js";
import { HttpError } from "../utils/retry.js";
import { formatUserError } from "../utils/errorMessage.js";

export interface IndexCommandCtx {
  outlineClient: OutlineClient;
  logger: Logger;
  /** Posts a message in the thread of the command (used for the final report). */
  say: (message: string) => Promise<unknown>;
}

function minutesBetween(from: string, to: string | null): string {
  const ms = (to ? Date.parse(to) : Date.now()) - Date.parse(from);
  const min = ms / 60_000;
  return min < 1 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(min * 10) / 10} min`;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString("it-IT", { timeZone: "Europe/Rome", dateStyle: "short", timeStyle: "short" });
}

function totalsLine(): string {
  const { documents, chunks } = indexStats();
  return `Nell'indice: **${documents}** documenti, ${chunks} sezioni.`;
}

function failuresBlock(s: SyncStats): string {
  if (s.failures.length === 0) return "";
  const lines = s.failures.map((f) => `• ${f.title} — _${f.error.split("\n")[0]?.slice(0, 120)}_`);
  const more = s.failed > s.failures.length ? `\n• … e altri ${s.failed - s.failures.length}` : "";
  return `\n**Non indicizzati** (riprovo alla prossima sincronizzazione):\n${lines.join("\n")}${more}`;
}

export function renderSyncReport(s: SyncStats): string {
  const head = s.error
    ? `⚠️ Indicizzazione interrotta dopo ${minutesBetween(s.startedAt, s.finishedAt)}: ${s.error.slice(0, 200)}`
    : `✅ Indicizzazione${s.force ? " completa" : ""} terminata in ${minutesBetween(s.startedAt, s.finishedAt)}.`;
  return (
    `${head}\n` +
    `Documenti visti in Outline: ${s.seen} · nuovi/aggiornati: **${s.indexed}** · invariati: ${s.skipped} · ` +
    `errori: ${s.failed} · rimossi: ${s.pruned}\n` +
    totalsLine() +
    failuresBlock(s)
  );
}

function renderStatus(): string {
  const running = currentSyncProgress();
  const last = lastSyncResult();
  const lines = [`🗂️ **Indice di ricerca**`, totalsLine()];
  if (running) {
    lines.push(
      `⏳ Indicizzazione${running.force ? " completa" : ""} in corso da ${minutesBetween(running.startedAt, null)}: ` +
        `${running.seen} documenti esaminati, ${running.indexed} aggiornati, ${running.failed} errori.`,
    );
  }
  if (last?.finishedAt) {
    lines.push(
      `Ultima indicizzazione: ${formatTime(last.finishedAt)} — ${last.indexed} aggiornati, ${last.failed} errori` +
        (last.error ? ` ⚠️ interrotta: ${last.error.slice(0, 150)}` : ""),
    );
  } else if (!running) {
    lines.push("Ultima indicizzazione: nessuna registrata.");
  }
  lines.push(`Sincronizzazione automatica ogni ${config.INDEX_SYNC_INTERVAL_MINUTES} min.`);
  return lines.join("\n");
}

/** One-line summary for `@bot status`. */
export function indexStatusLine(): string {
  const { documents, chunks } = indexStats();
  const running = currentSyncProgress();
  const last = lastSyncResult();
  const when = running
    ? `indicizzazione in corso (${running.seen} documenti esaminati)`
    : last?.finishedAt
      ? `ultima indicizzazione ${formatTime(last.finishedAt)}${last.failed ? `, ${last.failed} errori` : ""}`
      : "nessuna indicizzazione registrata";
  return `Indice: ${documents} documenti, ${chunks} sezioni · ${when}`;
}

/** Starts a sync in the background and reports in the thread when it ends. */
function startSync(force: boolean, ctx: IndexCommandCtx): string {
  const running = currentSyncProgress();
  if (running) {
    return (
      `⏳ C'è già un'indicizzazione${running.force ? " completa" : ""} in corso (da ${minutesBetween(running.startedAt, null)}, ` +
      `${running.seen} documenti esaminati). Ti scrivo qui quando finisce.` +
      (force && !running.force ? "\nQuella in corso aggiorna solo i documenti modificati: rilancia `indicizza tutto` quando termina." : "")
    );
  }
  void runFullSync(ctx.outlineClient, { force })
    .then((stats) => ctx.say(renderSyncReport(stats)))
    .catch((err: unknown) => {
      ctx.logger.error({ err }, "manual_index_sync_failed");
      return ctx.say(`⚠️ Indicizzazione fallita: ${formatUserError(err)}`);
    });
  return force
    ? "🔄 Avviata l'indicizzazione **completa**: riscarico e ricalcolo tutti i documenti. Può richiedere parecchio tempo; ti scrivo qui quando finisce."
    : "🔄 Avviata l'indicizzazione dei documenti nuovi o modificati. Ti scrivo qui quando finisce.";
}

async function indexOneDocument(rawRef: string, channelId: string, ctx: IndexCommandCtx): Promise<string> {
  const ref = documentRefFromText(rawRef);
  if (!ref) {
    return (
      "⚠️ Non riconosco il documento. Incolla il link Outline del documento, ad es. " +
      `\`@${config.MM_BOT_USERNAME} indicizza ${config.OUTLINE_URL.replace(/\/$/, "")}/doc/titolo-AbC123xyz\``
    );
  }

  let result;
  try {
    result = await indexSingleDocument(ctx.outlineClient, ref);
  } catch (err) {
    if (err instanceof HttpError && [400, 403, 404].includes(err.status)) {
      return (
        "⛔ Outline non mi fa leggere questo documento. Possibili cause:\n" +
        "• l'utente del bot su Outline (quello del token API) non ha accesso alla sua collection;\n" +
        "• il documento è stato eliminato o archiviato;\n" +
        "• il link è sbagliato."
      );
    }
    throw err;
  }

  const { doc, chunks } = result;
  const lines = [`✅ Indicizzato [${doc.title}](${documentUrl(config.OUTLINE_URL, doc)}): ${chunks} sezioni.`];

  if (!doc.publishedAt) {
    lines.push(
      "⚠️ Il documento è una **bozza**: la sincronizzazione automatica considera solo i documenti pubblicati. " +
        "Pubblicalo su Outline, altrimenti alla prossima modifica non verrà aggiornato.",
    );
  }
  if (chunks === 0) {
    lines.push("⚠️ Il documento non contiene testo da indicizzare (è vuoto o contiene solo immagini/allegati).");
  }

  // The most common reason for "the bot can't find it": the document lives in
  // a collection that isn't linked to this channel, so searches here skip it.
  if (doc.collectionId) {
    const scope = await getEffectiveCollections(ctx.outlineClient, ctx.logger, channelId);
    if (scope.length > 0 && !scope.some((c) => c.id === doc.collectionId)) {
      const name =
        (await listCollections(ctx.outlineClient).catch(() => [])).find((c) => c.id === doc.collectionId)?.name ??
        doc.collectionId;
      lines.push(
        `⚠️ La sua collection **${name}** non è collegata a questo canale, quindi le domande fatte qui **non** lo trovano.\n` +
          `Per collegarla: \`@${config.MM_BOT_USERNAME} collezioni aggiungi ${name}\`` +
          ` (oppure \`collezioni aggiungi globale ${name}\` per tutti i canali).`,
      );
    }
  }
  return lines.join("\n");
}

/** Handles `@bot indicizza …` and returns the immediate reply. */
export async function handleIndexCommand(opts: {
  args: string;
  channelId: string;
  username: string;
  ctx: IndexCommandCtx;
}): Promise<string> {
  const action = parseIndexArgs(opts.args);
  switch (action.action) {
    case "status":
      return renderStatus();
    case "sync":
      return startSync(false, opts.ctx);
    case "full":
      if (!isAdmin(opts.username)) {
        return "⛔ Solo gli amministratori del bot (`BOT_ADMINS`) possono lanciare l'indicizzazione completa. Puoi usare `indicizza` (solo documenti nuovi o modificati).";
      }
      return startSync(true, opts.ctx);
    case "document":
      return indexOneDocument(action.ref, opts.channelId, opts.ctx);
  }
}

export function indexHelp(): string {
  const bot = `@${config.MM_BOT_USERNAME}`;
  return `**Indice di ricerca**
• \`${bot} indicizza\` — aggiorna subito l'indice con i documenti nuovi o modificati
• \`${bot} indicizza <link documento>\` — indicizza subito un documento e controlla se è visibile da questo canale
• \`${bot} indicizza stato\` — documenti indicizzati, ultima sincronizzazione, errori
• \`${bot} indicizza tutto\` — ricostruisce l'intero indice (solo admin, lento)`;
}
