import type { MattermostClient, Post } from "../mattermost/client.js";
import type { OutlineClient } from "../outline/client.js";
import type { Logger } from "../logger.js";
import { config } from "../config.js";
import { sortThreadPosts } from "../mattermost/helpers.js";
import { search, type RetrievedChunk } from "../search/retrieval.js";
import { generateAnswer, type AnswerMode, type ConversationMessage } from "../search/answerGeneration.js";
import { llmQueueDepth } from "../ai/client.js";
import { getEffectiveCollections } from "./collectionScope.js";
import { formatUserError } from "../utils/errorMessage.js";

export interface QuestionCtx {
  mmClient: MattermostClient;
  outlineClient: OutlineClient;
  logger: Logger;
  botUserId: string;
}

/**
 *  kb      → `cerca`: answer only from the knowledge base
 *  general → `chiedi`: plain LLM answer, the KB is not consulted
 *  auto    → free text: KB-grounded when relevant documents exist, else general
 */
export type QuestionMode = "kb" | "general" | "auto";

const MAX_CONTEXT_MESSAGES = 12;

function absoluteUrl(url: string): string {
  return url.startsWith("/") ? `${config.OUTLINE_URL.replace(/\/$/, "")}${url}` : url;
}

async function threadConversation(post: Post, ctx: QuestionCtx): Promise<ConversationMessage[]> {
  if (!post.root_id) return [];
  try {
    const posts = sortThreadPosts(await ctx.mmClient.getThread(post.root_id)).filter(
      (p) => p.id !== post.id && p.create_at <= post.create_at && p.message.trim(),
    );
    const recent = posts.slice(-MAX_CONTEXT_MESSAGES);
    const ids = [...new Set(recent.map((p) => p.user_id))];
    const users = await ctx.mmClient.getUsersByIds(ids);
    const names = new Map(users.map((u) => [u.id, u.username]));
    return recent.map((p) => ({
      username: names.get(p.user_id) ?? p.user_id,
      message: p.message,
      isBot: p.user_id === ctx.botUserId,
    }));
  } catch (err) {
    ctx.logger.warn({ err }, "thread_context_fetch_failed");
    return [];
  }
}

function renderSources(sources: Array<{ title: string; url: string; heading: string }>): string {
  const seen = new Set<string>();
  const unique = sources.filter((s) => {
    if (seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  });
  if (unique.length === 0) return "";
  return (
    "\n\n**Fonti:**\n" +
    unique
      .map((s, i) => `[${i + 1}] [${s.title}${s.heading !== s.title ? ` › ${s.heading}` : ""}](${absoluteUrl(s.url)})`)
      .join("\n")
  );
}

export async function answerQuestion(opts: {
  post: Post;
  query: string;
  mode: QuestionMode;
  ctx: QuestionCtx;
}): Promise<void> {
  const { post, query, mode, ctx } = opts;
  const { mmClient, outlineClient, logger } = ctx;
  const rootId = post.root_id || post.id;

  const { pending } = llmQueueDepth();
  const queued = pending > 0 ? `⏳ In coda (${pending} richieste prima)… ` : "";
  const progress = await mmClient.createPost({
    channel_id: post.channel_id,
    root_id: rootId,
    message: mode === "general" ? `${queued}💭 Ci penso…` : `${queued}🔍 Cerco nella knowledge base: _${query}_…`,
  });

  try {
    const conversation = await threadConversation(post, ctx);

    let chunks: RetrievedChunk[] = [];
    let searchFailed = false;
    let scopeNote = "";
    if (mode !== "general") {
      const collections = await getEffectiveCollections(outlineClient, logger, post.channel_id);
      // No linked collections → search the whole indexed wiki (legacy behaviour).
      const scope = collections.length > 0 ? { collectionIds: collections.map((c) => c.id) } : undefined;
      if (!scope) scopeNote = "\n_(nessuna collection collegata al canale: ho cercato in tutta la wiki)_";
      try {
        chunks = await search(query, config.SEARCH_TOP_K, scope);
      } catch (err) {
        searchFailed = true;
        logger.warn({ err }, "kb_search_failed");
      }
    }

    let answerMode: AnswerMode;
    let prefix = "";
    if (mode === "general") {
      answerMode = "general";
    } else if (chunks.length > 0) {
      answerMode = mode === "kb" ? "kb" : "hybrid";
    } else if (mode === "kb" || !config.GENERAL_QA_ENABLED) {
      await mmClient.updatePost(
        progress.id,
        searchFailed
          ? `⚠️ La ricerca nella knowledge base non è disponibile al momento (servizio di embedding non raggiungibile).`
          : `❌ Nessun documento rilevante trovato per: _${query}_${scopeNote}` +
              (config.GENERAL_QA_ENABLED ? `\nPer una risposta generica usa \`@${config.MM_BOT_USERNAME} chiedi ${query}\`.` : ""),
      );
      return;
    } else {
      answerMode = "general";
      prefix = searchFailed
        ? "_ℹ️ Knowledge base non raggiungibile: rispondo con conoscenze generali._\n\n"
        : "_ℹ️ Nessun documento rilevante nella knowledge base: rispondo con conoscenze generali._\n\n";
    }

    const { answer, sources } = await generateAnswer(query, chunks, { mode: answerMode, conversation });
    const body = answer.trim() || "⚠️ Il modello ha restituito una risposta vuota, riprova.";
    await mmClient.updatePost(progress.id, `${prefix}${body}${renderSources(sources)}${sources.length > 0 ? scopeNote : ""}`);

    logger.info(
      {
        mode,
        answer_mode: answerMode,
        chunks: chunks.length,
        top_score: chunks[0]?.score ?? null,
        keyword_hits: chunks.filter((c) => c.keywordRank !== null).length,
      },
      "question_answered",
    );
  } catch (err) {
    logger.error({ err, query }, "question_failed");
    await mmClient.updatePost(progress.id, `⚠️ Errore durante la risposta: ${formatUserError(err)}`).catch(() => undefined);
  }
}
