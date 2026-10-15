import type { WsEvent } from "../websocket.js";
import type { MattermostClient, Post } from "../client.js";
import type { OutlineClient } from "../../outline/client.js";
import type { Config } from "../../config.js";
import type { Logger } from "../../logger.js";
import { parseMention } from "../helpers.js";
import { db } from "../../db/index.js";
import { withChannelLock } from "../../utils/locks.js";
import { parseCommand, parseProposalReply } from "../../core/commandParser.js";
import { formatUserError } from "../../utils/errorMessage.js";
import { ensureChannelRegistered } from "../../core/channelRegistry.js";
import { handleCollectionsCommand, collectionsHelp } from "../../core/collectionCommands.js";
import { getEffectiveCollections } from "../../core/collectionScope.js";
import { answerQuestion } from "../../core/questionFlow.js";
import {
  startSaveProposal,
  applyProposal,
  cancelProposal,
  reviseProposal,
  canDecide,
  type SmartSaveCtx,
} from "../../core/smartSave.js";
import { findActiveProposalByThread, countPendingProposals } from "../../db/repositories/saveProposals.js";
import { llmDescription } from "../../ai/client.js";

interface PostedCtx {
  client: MattermostClient;
  outlineClient: OutlineClient;
  config: Config;
  logger: Logger;
  botUserId: string;
  teamName: string;
}

type PostedEvent = Extract<WsEvent, { event: "posted" }>;

const lastSuccessfulSaveStmt = db.prepare(
  `SELECT created_at, triggered_by_username AS username,
          json_extract(payload_json, '$.document_title') AS document_title,
          json_extract(payload_json, '$.document_url') AS document_url
   FROM saves WHERE mm_channel_id = ? AND status = 'success'
   ORDER BY id DESC LIMIT 1`,
);

async function usernameOf(client: MattermostClient, userId: string): Promise<string> {
  try {
    const [u] = await client.getUsersByIds([userId]);
    return u?.username ?? userId;
  } catch {
    return userId;
  }
}

function isBotMentioned(post: Post, botUserId: string): boolean {
  const rawMentions = post.props?.["mentions"];
  if (rawMentions === undefined) return false;
  let mentions: unknown = rawMentions;
  if (typeof mentions === "string") {
    try {
      mentions = JSON.parse(mentions);
    } catch {
      return false;
    }
  }
  return Array.isArray(mentions) && (mentions as unknown[]).includes(botUserId);
}

/**
 * A reply inside a thread with a pending proposal: approve / cancel / redirect.
 * Returns true when the message was consumed.
 */
async function handleProposalReply(post: Post, text: string, ctx: PostedCtx, addressedToBot: boolean): Promise<boolean> {
  const proposal = findActiveProposalByThread(post.root_id);
  if (!proposal) return false;
  const reply = parseProposalReply(text);
  if (!reply) return false;

  const username = await usernameOf(ctx.client, post.user_id);
  if (!canDecide(proposal, post.user_id, username)) {
    // A plain "ok" between colleagues isn't necessarily meant for the bot.
    if (!addressedToBot) return false;
    await ctx.client.createPost({
      channel_id: post.channel_id,
      root_id: post.root_id,
      message: `⛔ @${username}, solo chi ha richiesto il salvataggio (o un approvatore configurato) può decidere su questa proposta.`,
    });
    return true;
  }

  const saveCtx: SmartSaveCtx = {
    mmClient: ctx.client,
    outlineClient: ctx.outlineClient,
    logger: ctx.logger,
    botUserId: ctx.botUserId,
  };
  ctx.logger.info({ proposal_id: proposal.id, reply: reply.kind }, "proposal_reply_received");

  await withChannelLock(post.channel_id, async () => {
    if (reply.kind === "approve") {
      await applyProposal({ proposal, actorUserId: post.user_id, actorUsername: username, ctx: saveCtx });
    } else if (reply.kind === "cancel") {
      await cancelProposal({ proposal, actorUsername: username, ctx: saveCtx });
      await ctx.client.createPost({ channel_id: post.channel_id, root_id: post.root_id, message: "👌 Proposta annullata, non ho modificato nulla." });
    } else {
      await reviseProposal({ proposal, change: reply, ctx: saveCtx });
    }
  });
  return true;
}

function helpText(config: Config): string {
  const bot = `@${config.MM_BOT_USERNAME}`;
  return `**Knowledge Bot — comandi**

**Domande**
• \`${bot} <domanda>\` — risponde usando la knowledge base quando pertinente, altrimenti con conoscenze generali${config.GENERAL_QA_ENABLED ? "" : " _(risposte generiche disabilitate)_"}
• \`${bot} cerca <domanda>\` — risponde **solo** dalla knowledge base, con le fonti
• \`${bot} chiedi <domanda>\` — domanda generica all'AI, senza consultare la knowledge base
_In un thread il bot tiene conto dei messaggi precedenti._

**Salvare conoscenza** (in un thread)
• \`${bot} salva\` — analizza il thread, trova collection e documento giusti e **propone** la modifica
• \`${bot} salva <indicazioni>\` — es. \`salva aggiorna la fase 2 del progetto ACME\`
Nessuna modifica viene applicata senza conferma: 👍/✅ o \`ok\` per applicare, 👎/❌ o \`annulla\` per scartare,
\`doc: …\`, \`collezione: …\`, \`sotto: …\`, \`titolo: …\`, \`nota: …\` per correggere la proposta.

${collectionsHelp()}

**Altro**
• \`${bot} status\` — collection collegate, proposte in attesa, ultimo salvataggio
• \`${bot} help\` — questo messaggio

Wiki: ${config.OUTLINE_URL}`;
}

export async function handlePosted(event: PostedEvent, ctx: PostedCtx): Promise<void> {
  const { client, outlineClient, config, logger, botUserId, teamName } = ctx;

  let post: Post;
  try {
    post = JSON.parse(event.data.post) as Post;
  } catch {
    logger.warn({ raw: event.data.post }, "posted_invalid_json");
    return;
  }

  if (post.user_id === botUserId) return;
  // System messages (joins, header changes…) are never commands.
  if (post.type && post.type.startsWith("system_")) return;

  const { mentioned, afterMention } = parseMention(post.message, config.BOT_TRIGGER_MENTIONS);
  const mentionedViaProps = !mentioned && isBotMentioned(post, botUserId);

  // In a direct message with the bot every message is addressed to it.
  const isDirect = event.data.channel_type === "D";
  if (!mentioned && !mentionedViaProps && !isDirect) {
    // Thread replies may still be decisions on a pending proposal ("ok", "doc: …").
    if (post.root_id) {
      try {
        await handleProposalReply(post, post.message, ctx, false);
      } catch (err) {
        logger.error({ err }, "proposal_reply_failed");
      }
    }
    return;
  }

  const commandText = mentioned ? afterMention : post.message;
  logger.info(
    { post_id: post.id, channel_id: post.channel_id, root_id: post.root_id, user_id: post.user_id },
    "posted_bot_mentioned",
  );

  if (post.root_id) {
    try {
      if (await handleProposalReply(post, commandText, ctx, true)) return;
    } catch (err) {
      logger.error({ err }, "proposal_reply_failed");
      return;
    }
  }

  const rootId = post.root_id || post.id;
  const say = (message: string) => client.createPost({ channel_id: post.channel_id, root_id: rootId, message });

  let channelRow;
  try {
    channelRow = (
      await ensureChannelRegistered({ channelId: post.channel_id, mmClient: client, outlineClient, logger, botUserId })
    ).row;
  } catch (err) {
    logger.error({ err, channel_id: post.channel_id }, "channel_registration_failed");
    await say(`⚠️ Non riesco a configurare questo canale: ${formatUserError(err)}`);
    return;
  }

  const command = parseCommand(commandText);
  const questionCtx = { mmClient: client, outlineClient, logger, botUserId };

  switch (command.subcommand) {
    case "unknown":
      await say(
        `Ciao! Fammi una domanda (\`@${config.MM_BOT_USERNAME} <domanda>\`), ` +
          `oppure usa \`@${config.MM_BOT_USERNAME} salva\` in un thread per salvarlo nella wiki. ` +
          `\`@${config.MM_BOT_USERNAME} help\` per tutti i comandi.`,
      );
      return;

    case "help":
      await say(helpText(config));
      return;

    case "search":
    case "ask":
    case "question": {
      const query = command.searchQuery ?? "";
      if (!query) {
        const kw = command.subcommand === "search" ? "cerca" : "chiedi";
        await say(`Uso: \`@${config.MM_BOT_USERNAME} ${kw} <domanda>\``);
        return;
      }
      const mode = command.subcommand === "search" ? "kb" : command.subcommand === "ask" ? "general" : "auto";
      if (mode === "general" && !config.GENERAL_QA_ENABLED) {
        await say("ℹ️ Le domande generiche sono disabilitate su questo bot: uso solo la knowledge base.");
        await answerQuestion({ post, query, mode: "kb", ctx: questionCtx });
        return;
      }
      await answerQuestion({ post, query, mode, ctx: questionCtx });
      return;
    }

    case "collections": {
      try {
        const username = await usernameOf(client, post.user_id);
        const message = await withChannelLock(post.channel_id, () =>
          handleCollectionsCommand({
            args: command.args,
            channelId: post.channel_id,
            userId: post.user_id,
            username,
            ctx: { mmClient: client, outlineClient, logger },
          }),
        );
        await say(message);
      } catch (err) {
        logger.error({ err }, "collections_command_failed");
        await say(`⚠️ Errore: ${formatUserError(err)}`);
      }
      return;
    }

    case "status": {
      const collections = await getEffectiveCollections(outlineClient, logger, post.channel_id);
      const lastSave = lastSuccessfulSaveStmt.get(post.channel_id) as
        | { created_at: string; username: string; document_title: string | null; document_url: string | null }
        | undefined;
      const lastLine = lastSave
        ? `Ultimo salvataggio: ${lastSave.created_at} da @${lastSave.username}` +
          (lastSave.document_title ? ` → [${lastSave.document_title}](${lastSave.document_url ?? ""})` : "")
        : "Ultimo salvataggio: nessuno";
      await say(
        `📚 **Stato del bot in ${channelRow.mm_channel_name}**\n` +
          `Collection: ${collections.length > 0 ? collections.map((c) => c.name).join(", ") : "_nessuna_ (\`collezioni aggiungi\`)"}\n` +
          `Proposte in attesa: ${countPendingProposals(post.channel_id)}\n` +
          `${lastLine}\n` +
          `Modello: \`${llmDescription()}\` · Approvazione: \`${config.SAVE_APPROVAL_MODE}\``,
      );
      return;
    }

    case "save": {
      if (!post.root_id) {
        await say(
          `⚠️ Per salvare una discussione, menzionami **rispondendo dentro un thread**: \`@${config.MM_BOT_USERNAME} salva\`.`,
        );
        return;
      }
      await withChannelLock(post.channel_id, () =>
        startSaveProposal({
          post,
          hint: command.args || null,
          teamName,
          ctx: { mmClient: client, outlineClient, logger, botUserId },
        }),
      );
      return;
    }
  }
}
