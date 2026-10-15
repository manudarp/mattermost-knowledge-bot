import type { MattermostClient, Post } from "../mattermost/client.js";
import type { OutlineClient } from "../outline/client.js";
import type { Logger } from "../logger.js";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { buildPermalink, sortThreadPosts } from "../mattermost/helpers.js";
import { getEffectiveCollections, type ScopedCollection } from "./collectionScope.js";
import {
  getCollectionTree,
  flattenTree,
  resolveCollectionRef,
  type NavigationNode,
} from "../outline/collections.js";
import {
  createDocument,
  getDocument,
  updateDocument,
  documentRefFromText,
  documentUrl,
  type OutlineDocument,
} from "../outline/documents.js";
import { searchDocuments } from "../search/retrieval.js";
import { planPlacement, type PlacementCollection } from "../ai/placement.js";
import { draftDocumentUpdate, draftNewDocument } from "../ai/contentWriter.js";
import { applyEdits, EditError, type EditOp } from "./markdownSections.js";
import { extractThreadAttachments, uploadAttachments, type ExtractedAttachment, type UploadedAttachment } from "./attachmentHandler.js";
import { indexDocument } from "../indexer/outlineIndexer.js";
import {
  insertProposal,
  findProposalByTrigger,
  findProposalById,
  transitionProposal,
  setProposalStatus,
  updateProposalPayload,
  type SaveProposalRow,
} from "../db/repositories/saveProposals.js";
import type { ProposalReply } from "./commandParser.js";
import { formatUserError } from "../utils/errorMessage.js";
import { HttpError } from "../utils/retry.js";

export interface SmartSaveCtx {
  mmClient: MattermostClient;
  outlineClient: OutlineClient;
  logger: Logger;
  botUserId: string;
}

interface ProposalTarget {
  action: "update" | "create";
  collectionId: string;
  collectionName: string;
  /** update: the document being edited */
  documentId: string | null;
  /** update: current title; create: title of the new document */
  documentTitle: string;
  documentUrl: string | null;
  /** create: parent document, if nested */
  parentDocumentId: string | null;
  /** Titles from the collection root down to the target (update) or the parent (create). */
  path: string[];
}

export interface ProposalPayload {
  version: 1;
  channelId: string;
  rootId: string;
  teamName: string;
  requesterUserId: string;
  requesterUsername: string;
  permalink: string;
  hint: string | null;
  extraInstructions: string[];
  threadText: string;
  attachments: ExtractedAttachment[];
  target: ProposalTarget;
  confidence: number;
  reasoning: string;
  alternatives: Array<{ label: string; reason: string }>;
  /** update: revision the edits were drafted against */
  baseRevision: number | null;
  edits: EditOp[] | null;
  newDocText: string | null;
  changeSummary: string;
}

const MAX_THREAD_CHARS = 30_000;
const MAX_POST_CHARS = 15_000; // Mattermost hard limit is 16383
const CANDIDATE_DOCS = 6;

const insertSaveAuditStmt = db.prepare(
  `INSERT OR IGNORE INTO saves (mm_channel_id, mm_post_id, mm_root_post_id, triggered_by_user_id, triggered_by_username,
     outline_revision_before, outline_revision_after, status, error_message, payload_json)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);

function expiresAt(): string {
  return new Date(Date.now() + config.CONFIRMATION_TTL_MINUTES * 60_000).toISOString();
}

// ---------------------------------------------------------------------------
// Thread / context helpers
// ---------------------------------------------------------------------------

function formatThread(posts: Post[], usernames: Map<string, string>, botUserId: string): string {
  const lines = posts
    .filter((p) => p.user_id !== botUserId && (p.message.trim() || (p.file_ids?.length ?? 0) > 0))
    .map((p) => {
      const files = (p.file_ids?.length ?? 0) > 0 ? ` [${p.file_ids!.length} allegato/i]` : "";
      return `[${new Date(p.create_at).toISOString().slice(0, 16)}] @${usernames.get(p.user_id) ?? p.user_id}: ${p.message.slice(0, 4000)}${files}`;
    });
  // Keep the root post plus the most recent messages within budget.
  let text = lines.join("\n");
  if (text.length > MAX_THREAD_CHARS && lines.length > 1) {
    const first = lines[0]!;
    const tail: string[] = [];
    let budget = MAX_THREAD_CHARS - first.length - 50;
    for (let i = lines.length - 1; i > 0; i--) {
      if (lines[i]!.length > budget) break;
      budget -= lines[i]!.length + 1;
      tail.unshift(lines[i]!);
    }
    text = [first, "[… messaggi intermedi omessi …]", ...tail].join("\n");
  }
  return text;
}

class TreeCache {
  private trees = new Map<string, NavigationNode[]>();
  constructor(private readonly outlineClient: OutlineClient, private readonly logger: Logger) {}

  async get(collectionId: string): Promise<NavigationNode[]> {
    const cached = this.trees.get(collectionId);
    if (cached) return cached;
    let tree: NavigationNode[] = [];
    try {
      tree = await getCollectionTree(this.outlineClient, collectionId);
    } catch (err) {
      this.logger.warn({ err, collectionId }, "collection_tree_fetch_failed");
    }
    this.trees.set(collectionId, tree);
    return tree;
  }

  async pathOf(collectionId: string, docId: string): Promise<string[]> {
    const entry = flattenTree(await this.get(collectionId)).find((e) => e.id === docId);
    return entry?.path ?? [];
  }

  async childrenTitles(collectionId: string, parentId: string | null): Promise<string[]> {
    const tree = await this.get(collectionId);
    if (!parentId) return tree.map((n) => n.title);
    const find = (nodes: NavigationNode[]): NavigationNode | null => {
      for (const n of nodes) {
        if (n.id === parentId) return n;
        const inner = find(n.children ?? []);
        if (inner) return inner;
      }
      return null;
    };
    return find(tree)?.children.map((c) => c.title) ?? [];
  }
}

function readableAttachments(atts: ExtractedAttachment[]): Array<{ filename: string; text: string }> {
  return atts.filter((a) => a.text && a.text.trim()).map((a) => ({ filename: a.filename, text: a.text! }));
}

function isLive(doc: OutlineDocument): boolean {
  return !doc.deletedAt && !doc.archivedAt;
}

// ---------------------------------------------------------------------------
// Drafting
// ---------------------------------------------------------------------------

/** (Re)generates the content of a proposal for its current target. Mutates payload. */
async function draftForTarget(payload: ProposalPayload, ctx: SmartSaveCtx, trees: TreeCache): Promise<void> {
  const common = {
    todayIso: new Date().toISOString().slice(0, 10),
    hint: payload.hint,
    extraInstructions: payload.extraInstructions,
    threadText: payload.threadText,
    attachments: readableAttachments(payload.attachments),
  };
  const t = payload.target;

  if (t.action === "update") {
    const doc = await getDocument(ctx.outlineClient, t.documentId!);
    if (!isLive(doc)) throw new UserFacingError(`il documento «${doc.title}» è archiviato o eliminato`);
    t.documentTitle = doc.title;
    t.documentUrl = documentUrl(config.OUTLINE_URL, doc);
    if (t.path.length === 0) t.path = await trees.pathOf(t.collectionId, doc.id);

    const draft = await draftDocumentUpdate({
      ...common,
      documentTitle: doc.title,
      documentPath: [t.collectionName, ...t.path],
      currentText: doc.text ?? "",
      changelogHeading: config.SAVE_CHANGELOG_HEADING,
    });
    payload.baseRevision = doc.revision ?? null;
    payload.edits = draft.edits;
    payload.newDocText = null;
    payload.changeSummary = draft.changeSummary;
    return;
  }

  const draft = await draftNewDocument({
    ...common,
    title: t.documentTitle,
    collectionName: t.collectionName,
    parentPath: t.path,
    siblingTitles: await trees.childrenTitles(t.collectionId, t.parentDocumentId),
  });
  t.documentTitle = draft.title;
  payload.baseRevision = null;
  payload.edits = null;
  payload.newDocText = draft.text;
  payload.changeSummary = draft.changeSummary;
}

class UserFacingError extends Error {}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function fence(content: string, max: number): string {
  let body = content.trim();
  if (body.length > max) body = `${body.slice(0, max)}\n… [troncato: ${content.length - max} caratteri in più]`;
  return "````markdown\n" + body + "\n````";
}

function describeEdit(e: EditOp): string {
  switch (e.op) {
    case "append_to_section":
      return `➕ **Aggiunge** alla sezione «${e.heading}»:`;
    case "replace_section":
      return `✏️ **Sostituisce** il contenuto della sezione «${e.heading}» (le sotto-sezioni restano):`;
    case "add_section":
      return `🆕 **Nuova sezione** «${e.heading}»${e.after_heading ? ` dopo «${e.after_heading}»` : " in fondo al documento"}:`;
  }
}

function approversLabel(payload: ProposalPayload): string {
  const extra = config.SAVE_APPROVERS.filter((u) => u !== payload.requesterUsername.toLowerCase());
  return [`@${payload.requesterUsername}`, ...extra.map((u) => `@${u}`)].join(", ");
}

export function renderProposal(id: number, payload: ProposalPayload, statusLine?: string): string {
  const t = payload.target;
  const lines: string[] = [];
  lines.push(statusLine ?? `📝 **Proposta di modifica alla knowledge base** · #${id}`);
  lines.push("");

  if (t.action === "update") {
    lines.push(`**Azione:** ✏️ aggiornare [${t.documentTitle}](${t.documentUrl ?? ""})`);
    lines.push(`**Percorso:** ${[t.collectionName, ...t.path].join(" › ")}`);
  } else {
    lines.push(`**Azione:** 🆕 creare il documento **${t.documentTitle}**`);
    lines.push(`**Percorso:** ${[t.collectionName, ...t.path, t.documentTitle].join(" › ")}`);
  }
  lines.push(`**Confidenza:** ${Math.round(payload.confidence * 100)}% — ${payload.reasoning}`);
  if (payload.extraInstructions.length > 0) {
    lines.push(`**Istruzioni applicate:** ${payload.extraInstructions.map((i) => `_${i}_`).join(" · ")}`);
  }
  lines.push("");

  // Budget the preview so the post stays under Mattermost's size limit.
  const previewBudget = 9_000;
  if (t.action === "update") {
    const edits = payload.edits ?? [];
    if (edits.length === 0) {
      lines.push("_Nessuna modifica: il thread non aggiunge informazioni nuove a questo documento._");
    } else {
      const per = Math.max(400, Math.floor(previewBudget / edits.length));
      lines.push("**Modifiche proposte:**");
      for (const e of edits) {
        lines.push(describeEdit(e));
        lines.push(fence(e.content, per));
      }
    }
  } else {
    lines.push("**Contenuto proposto:**");
    lines.push(fence(payload.newDocText ?? "", previewBudget));
  }
  lines.push(`_Riepilogo: ${payload.changeSummary}_`);

  const unreadable = payload.attachments.filter((a) => a.unreadable).map((a) => `\`${a.filename}\``);
  if (unreadable.length > 0) {
    lines.push("");
    lines.push(
      `⚠️ Non sono riuscito a leggere il testo di: ${unreadable.join(", ")} (PDF scansionati/immagini o formati non supportati). ` +
        "Verranno comunque allegati al documento, ma il loro contenuto non è stato considerato.",
    );
  }

  if (payload.alternatives.length > 0) {
    lines.push("");
    lines.push("**Alternative considerate:** " + payload.alternatives.map((a) => `${a.label}${a.reason ? ` (${a.reason})` : ""}`).join(" · "));
  }

  if (!statusLine) {
    lines.push("");
    lines.push("---");
    lines.push("👍 o ✅ per **applicare** · 👎 o ❌ per **annullare** — oppure rispondi in questo thread con:");
    lines.push(
      "`ok` · `annulla` · `doc: <link o titolo>` (aggiorna un altro documento) · `collezione: <nome>` (nuovo documento lì) · " +
        "`sotto: <link o titolo>` (nuovo documento figlio di quello) · `titolo: <titolo>` · `nota: <istruzioni>` (rigenera)",
    );
    lines.push(`_Può approvare: ${approversLabel(payload)}. La proposta scade tra ${config.CONFIRMATION_TTL_MINUTES} minuti._`);
  }

  let msg = lines.join("\n");
  if (msg.length > MAX_POST_CHARS) msg = msg.slice(0, MAX_POST_CHARS - 40) + "\n… [anteprima troncata]";
  return msg;
}

// ---------------------------------------------------------------------------
// Entry point: `@bot salva [hint]`
// ---------------------------------------------------------------------------

export async function startSaveProposal(opts: {
  post: Post;
  hint: string | null;
  teamName: string;
  ctx: SmartSaveCtx;
}): Promise<void> {
  const { post, hint, teamName, ctx } = opts;
  const { mmClient, outlineClient, logger, botUserId } = ctx;
  const rootId = post.root_id || post.id;

  if (findProposalByTrigger(post.id)) {
    logger.info({ post_id: post.id }, "save_already_proposed_skipping");
    return;
  }

  const collections = await getEffectiveCollections(outlineClient, logger, post.channel_id);
  if (collections.length === 0) {
    await mmClient.createPost({
      channel_id: post.channel_id,
      root_id: rootId,
      message:
        `⚠️ Nessuna collection Outline collegata a questo canale, quindi non so dove salvare.\n` +
        `Collegane una con \`@${config.MM_BOT_USERNAME} collezioni aggiungi <nome>\` ` +
        `(vedi \`@${config.MM_BOT_USERNAME} collezioni disponibili\`).`,
    });
    return;
  }

  const ack = await mmClient.createPost({
    channel_id: post.channel_id,
    root_id: rootId,
    message: "🔄 Analizzo il thread e cerco il posto giusto nella knowledge base…",
  });

  try {
    const threadData = await mmClient.getThread(rootId);
    const thread = sortThreadPosts(threadData);
    const userIds = [...new Set(thread.map((p) => p.user_id))];
    const users = await mmClient.getUsersByIds(userIds);
    const usernames = new Map(users.map((u) => [u.id, u.username]));
    const requesterUsername = usernames.get(post.user_id) ?? post.user_id;

    const threadText = formatThread(thread, usernames, botUserId);
    const attachments = await extractThreadAttachments({ thread, mmClient, logger });

    const trees = new TreeCache(outlineClient, logger);
    const placementCollections: PlacementCollection[] = [];
    for (const c of collections) {
      const flat = flattenTree(await trees.get(c.id));
      placementCollections.push({
        id: c.id,
        name: c.name,
        docs: flat.map((d) => ({ id: d.id, title: d.title, depth: d.depth })),
      });
    }

    // Semantic candidates. Embeddings may be down — placement still works from the trees.
    let candidates: Awaited<ReturnType<typeof searchDocuments>> = [];
    try {
      const query = `${hint ?? ""}\n${threadText}`.slice(0, 6000);
      candidates = await searchDocuments(query, CANDIDATE_DOCS, { collectionIds: collections.map((c) => c.id) });
    } catch (err) {
      logger.warn({ err }, "save_candidate_search_failed");
    }

    const decision = await planPlacement({
      todayIso: new Date().toISOString().slice(0, 10),
      hint,
      extraInstructions: [],
      threadText,
      attachments: readableAttachments(attachments),
      collections: placementCollections,
      candidates: candidates.map((c) => ({
        docId: c.docId,
        title: c.docTitle,
        collectionId: c.collectionId,
        score: c.score,
        headings: [...new Set(c.headings)],
        snippet: c.bestChunks[0]?.content ?? "",
      })),
    });

    logger.info(
      { action: decision.action, document_id: decision.documentId, collection_id: decision.collectionId, confidence: decision.confidence },
      "save_placement_decided",
    );

    const collectionName = collections.find((c) => c.id === decision.collectionId)?.name ?? "?";
    const payload: ProposalPayload = {
      version: 1,
      channelId: post.channel_id,
      rootId,
      teamName,
      requesterUserId: post.user_id,
      requesterUsername,
      permalink: buildPermalink(config.MM_URL, teamName, rootId),
      hint,
      extraInstructions: [],
      threadText,
      attachments,
      target: {
        action: decision.action,
        collectionId: decision.collectionId,
        collectionName,
        documentId: decision.documentId,
        documentTitle: decision.title,
        documentUrl: null,
        parentDocumentId: decision.parentDocumentId,
        path:
          decision.action === "create" && decision.parentDocumentId
            ? await trees.pathOf(decision.collectionId, decision.parentDocumentId)
            : [],
      },
      confidence: decision.confidence,
      reasoning: decision.reasoning,
      alternatives: decision.alternatives,
      baseRevision: null,
      edits: null,
      newDocText: null,
      changeSummary: "",
    };

    await draftForTarget(payload, ctx, trees);

    const row = insertProposal({
      mm_channel_id: post.channel_id,
      mm_thread_root_id: rootId,
      mm_trigger_post_id: post.id,
      bot_reply_post_id: ack.id,
      requested_by_user_id: post.user_id,
      status: "pending",
      payload_json: JSON.stringify(payload),
      expires_at: expiresAt(),
    });

    await mmClient.updatePost(ack.id, renderProposal(row.id, payload));
    logger.info({ proposal_id: row.id, action: payload.target.action }, "save_proposal_created");

    if (shouldAutoApply(payload)) {
      logger.info({ proposal_id: row.id }, "save_proposal_auto_apply");
      await applyProposal({ proposal: row, actorUserId: post.user_id, actorUsername: requesterUsername, ctx, auto: true });
    }
  } catch (err) {
    logger.error({ err }, "save_proposal_failed");
    await mmClient
      .updatePost(ack.id, `⚠️ Non sono riuscito a preparare il salvataggio: ${formatUserError(err)}`)
      .catch((e) => logger.error({ err: e }, "save_proposal_failed_reply_failed"));
  }
}

function shouldAutoApply(payload: ProposalPayload): boolean {
  if (config.SAVE_APPROVAL_MODE !== "auto_high_conf") return false;
  if (payload.confidence < config.CONFIRMATION_CONFIDENCE_THRESHOLD) return false;
  if (payload.target.action === "update") {
    const edits = payload.edits ?? [];
    return edits.length > 0 && edits.every((e) => e.op !== "replace_section");
  }
  return true;
}

// ---------------------------------------------------------------------------
// Approval / cancellation / revision
// ---------------------------------------------------------------------------

export function canDecide(proposal: SaveProposalRow, userId: string, username: string | null): boolean {
  if (proposal.requested_by_user_id === userId) return true;
  return username !== null && config.SAVE_APPROVERS.includes(username.toLowerCase());
}

function loadPayload(proposal: SaveProposalRow): ProposalPayload {
  return JSON.parse(proposal.payload_json) as ProposalPayload;
}

function changelogEntry(
  payload: ProposalPayload,
  approver: string,
  uploads: UploadedAttachment[],
): string {
  const date = new Date().toISOString().slice(0, 10);
  const by =
    approver.toLowerCase() === payload.requesterUsername.toLowerCase()
      ? `@${payload.requesterUsername}`
      : `@${payload.requesterUsername} (approvato da @${approver})`;
  const lines = [`- ${date} · ${by} · ${payload.changeSummary} · [thread Mattermost](${payload.permalink})`];
  for (const u of uploads) lines.push(`  - 📎 [${u.filename}](${u.url})`);
  return lines.join("\n");
}

/** Adds the audit entry (and attachment links) to the document text. */
function withAuditTrail(text: string, payload: ProposalPayload, approver: string, uploads: UploadedAttachment[]): string {
  const heading = config.SAVE_CHANGELOG_HEADING.trim();
  if (heading) {
    return applyEdits(text, [
      { op: "add_section", heading, content: changelogEntry(payload, approver, uploads), level: 2, after_heading: null },
    ]);
  }
  if (uploads.length === 0) return text;
  const links = uploads.map((u) => (u.isImage ? `![${u.filename}](${u.url})` : `- 📎 [${u.filename}](${u.url})`)).join("\n");
  return applyEdits(text, [{ op: "add_section", heading: "Allegati", content: links, level: 2, after_heading: null }]);
}

async function reindex(ctx: SmartSaveCtx, doc: OutlineDocument, collectionId: string): Promise<void> {
  try {
    await indexDocument(ctx.outlineClient, doc.id, doc.title, doc.text ?? "", doc.revision ?? 0, doc.url ?? "", collectionId);
  } catch (err) {
    ctx.logger.warn({ err, docId: doc.id }, "inline_index_failed");
  }
}

export async function applyProposal(opts: {
  proposal: SaveProposalRow;
  actorUserId: string;
  actorUsername: string;
  ctx: SmartSaveCtx;
  auto?: boolean;
}): Promise<void> {
  const { proposal, actorUsername, ctx } = opts;
  const { mmClient, outlineClient, logger } = ctx;

  if (!transitionProposal(proposal.id, "pending", "working")) {
    logger.info({ proposal_id: proposal.id }, "proposal_apply_skipped_not_pending");
    return;
  }

  const payload = loadPayload(proposal);
  const t = payload.target;
  const reply = (message: string) =>
    mmClient.createPost({ channel_id: payload.channelId, root_id: payload.rootId, message });

  try {
    // The bot only writes into collections that are (still) linked to the channel.
    const allowed = await getEffectiveCollections(outlineClient, logger, payload.channelId);
    if (!allowed.some((c) => c.id === t.collectionId)) {
      throw new UserFacingError(`la collection «${t.collectionName}» non è più collegata a questo canale`);
    }

    const fileIds = payload.attachments.map((a) => a.fileId);
    let finalDoc: OutlineDocument;
    let revisionBefore: number | null = null;
    let note = "";

    if (t.action === "update" && (payload.edits ?? []).length === 0) {
      throw new UserFacingError(
        "la proposta non contiene modifiche. Indica un altro documento (`doc:`) o dai istruzioni (`nota:`)",
      );
    }

    if (t.action === "update") {
      const current = await getDocument(outlineClient, t.documentId!);
      if (!isLive(current)) throw new UserFacingError(`il documento «${current.title}» è stato archiviato o eliminato`);
      if (current.collectionId && current.collectionId !== t.collectionId && !allowed.some((c) => c.id === current.collectionId)) {
        throw new UserFacingError(`il documento «${current.title}» è stato spostato in una collection non collegata`);
      }
      revisionBefore = current.revision ?? null;
      if (payload.baseRevision !== null && current.revision !== payload.baseRevision) {
        note = "\n_Il documento era stato modificato nel frattempo: le modifiche sono state applicate sulla versione più recente._";
        logger.info({ proposal_id: proposal.id, base: payload.baseRevision, current: current.revision }, "proposal_applied_on_newer_revision");
      }

      let text: string;
      try {
        text = applyEdits(current.text ?? "", payload.edits ?? [], { keepLastHeading: config.SAVE_CHANGELOG_HEADING });
      } catch (err) {
        if (err instanceof EditError) {
          setProposalStatus(proposal.id, "pending");
          await reply(
            `⚠️ Il documento è cambiato e non riesco più ad applicare la proposta (${err.message}). ` +
              "Rispondi `nota: rigenera` per rifarla sulla versione attuale, oppure `annulla`.",
          );
          return;
        }
        throw err;
      }

      const uploads = await uploadAttachments({ fileIds, documentId: current.id, mmClient, outlineClient, logger });
      text = withAuditTrail(text, payload, actorUsername, uploads);
      finalDoc = await updateDocument(outlineClient, { id: current.id, text });
    } else {
      let text = (payload.newDocText ?? "").trim() + "\n";
      text = withAuditTrail(text, payload, actorUsername, []);
      finalDoc = await createDocument(outlineClient, {
        collectionId: t.collectionId,
        parentDocumentId: t.parentDocumentId,
        title: t.documentTitle,
        text,
      });
      if (fileIds.length > 0) {
        const uploads = await uploadAttachments({ fileIds, documentId: finalDoc.id, mmClient, outlineClient, logger });
        if (uploads.length > 0) {
          const withLinks = withAuditTrail((payload.newDocText ?? "").trim() + "\n", payload, actorUsername, uploads);
          finalDoc = await updateDocument(outlineClient, { id: finalDoc.id, text: withLinks });
        }
      }
    }

    setProposalStatus(proposal.id, "applied");
    const url = documentUrl(config.OUTLINE_URL, finalDoc);
    insertSaveAuditStmt.run(
      payload.channelId,
      proposal.mm_trigger_post_id,
      payload.rootId,
      payload.requesterUserId,
      payload.requesterUsername,
      revisionBefore === null ? null : String(revisionBefore),
      finalDoc.revision === undefined ? null : String(finalDoc.revision),
      "success",
      null,
      JSON.stringify({
        proposal_id: proposal.id,
        action: t.action,
        document_id: finalDoc.id,
        document_title: finalDoc.title,
        document_url: url,
        approved_by: actorUsername,
      }),
    );

    await reindex(ctx, finalDoc, finalDoc.collectionId ?? t.collectionId);

    const verb = t.action === "update" ? "Aggiornato" : "Creato";
    await mmClient
      .updatePost(
        proposal.bot_reply_post_id,
        renderProposal(proposal.id, payload, `✅ **Proposta #${proposal.id} applicata**${opts.auto ? " automaticamente (alta confidenza)" : ` da @${actorUsername}`}`),
      )
      .catch((err) => logger.warn({ err }, "proposal_post_update_failed"));
    await reply(`✅ ${verb} [${finalDoc.title}](${url})\n_${payload.changeSummary}_${note}`);
    logger.info({ proposal_id: proposal.id, document_id: finalDoc.id, action: t.action }, "proposal_applied");
  } catch (err) {
    logger.error({ err, proposal_id: proposal.id }, "proposal_apply_failed");
    const recoverable = err instanceof UserFacingError || (err instanceof HttpError && err.status < 500);
    setProposalStatus(proposal.id, recoverable ? "pending" : "failed");
    await reply(
      `⚠️ Non sono riuscito ad applicare la proposta: ${formatUserError(err)}` +
        (recoverable ? "\nPuoi reindirizzarla (`doc:` / `collezione:`) o `annulla`." : ""),
    ).catch(() => undefined);
  }
}

export async function cancelProposal(opts: {
  proposal: SaveProposalRow;
  actorUsername: string;
  ctx: SmartSaveCtx;
}): Promise<void> {
  const { proposal, actorUsername, ctx } = opts;
  if (!transitionProposal(proposal.id, "pending", "cancelled")) return;
  const payload = loadPayload(proposal);
  await ctx.mmClient
    .updatePost(proposal.bot_reply_post_id, renderProposal(proposal.id, payload, `❌ **Proposta #${proposal.id} annullata** da @${actorUsername}`))
    .catch((err) => ctx.logger.warn({ err }, "proposal_post_update_failed"));
  ctx.logger.info({ proposal_id: proposal.id }, "proposal_cancelled");
}

/** Resolves "link/UUID/urlId/title" to a live document inside the allowed collections. */
async function resolveDocument(
  ref: string,
  allowed: ScopedCollection[],
  ctx: SmartSaveCtx,
  trees: TreeCache,
): Promise<OutlineDocument> {
  const idRef = documentRefFromText(ref);
  let doc: OutlineDocument | null = null;

  if (idRef) {
    try {
      doc = await getDocument(ctx.outlineClient, idRef);
    } catch (err) {
      if (err instanceof HttpError && (err.status === 404 || err.status === 403 || err.status === 400)) {
        throw new UserFacingError(`documento non trovato: ${ref}`);
      }
      throw err;
    }
  } else {
    const needle = ref.trim().replace(/^["'«]|["'»]$/g, "").toLowerCase();
    const matches: Array<{ id: string; title: string }> = [];
    for (const c of allowed) {
      for (const e of flattenTree(await trees.get(c.id))) {
        if (e.title.toLowerCase() === needle) matches.push(e);
      }
    }
    if (matches.length === 0) {
      for (const c of allowed) {
        for (const e of flattenTree(await trees.get(c.id))) {
          if (e.title.toLowerCase().includes(needle)) matches.push(e);
        }
      }
    }
    if (matches.length === 0) throw new UserFacingError(`nessun documento «${ref}» nelle collection collegate`);
    if (matches.length > 1) {
      throw new UserFacingError(
        `«${ref}» è ambiguo: ${matches.slice(0, 5).map((m) => `«${m.title}»`).join(", ")}. Usa il link del documento.`,
      );
    }
    doc = await getDocument(ctx.outlineClient, matches[0]!.id);
  }

  if (!isLive(doc)) throw new UserFacingError(`il documento «${doc.title}» è archiviato o eliminato`);
  if (!doc.collectionId || !allowed.some((c) => c.id === doc!.collectionId)) {
    throw new UserFacingError(`«${doc.title}» non è in una collection collegata a questo canale`);
  }
  return doc;
}

export async function reviseProposal(opts: {
  proposal: SaveProposalRow;
  change: Exclude<ProposalReply, { kind: "approve" } | { kind: "cancel" }>;
  ctx: SmartSaveCtx;
}): Promise<void> {
  const { proposal, change, ctx } = opts;
  const { mmClient, outlineClient, logger } = ctx;

  if (!transitionProposal(proposal.id, "pending", "working")) return;
  const payload = loadPayload(proposal);
  const reply = (message: string) =>
    mmClient.createPost({ channel_id: payload.channelId, root_id: payload.rootId, message });

  try {
    const allowed = await getEffectiveCollections(outlineClient, logger, payload.channelId);
    const trees = new TreeCache(outlineClient, logger);
    const t = payload.target;

    switch (change.kind) {
      case "rename": {
        if (t.action !== "create") {
          throw new UserFacingError("`titolo:` vale solo per i nuovi documenti (non rinomino documenti esistenti)");
        }
        t.documentTitle = change.title.slice(0, 200);
        break;
      }
      case "instructions": {
        payload.extraInstructions.push(change.text.slice(0, 1000));
        break;
      }
      case "retarget_doc": {
        const doc = await resolveDocument(change.ref, allowed, ctx, trees);
        payload.target = {
          action: "update",
          collectionId: doc.collectionId!,
          collectionName: allowed.find((c) => c.id === doc.collectionId)?.name ?? "?",
          documentId: doc.id,
          documentTitle: doc.title,
          documentUrl: documentUrl(config.OUTLINE_URL, doc),
          parentDocumentId: null,
          path: await trees.pathOf(doc.collectionId!, doc.id),
        };
        break;
      }
      case "retarget_parent": {
        const parent = await resolveDocument(change.ref, allowed, ctx, trees);
        payload.target = {
          action: "create",
          collectionId: parent.collectionId!,
          collectionName: allowed.find((c) => c.id === parent.collectionId)?.name ?? "?",
          documentId: null,
          documentTitle: t.action === "create" ? t.documentTitle : payload.hint || t.documentTitle,
          documentUrl: null,
          parentDocumentId: parent.id,
          path: await trees.pathOf(parent.collectionId!, parent.id),
        };
        break;
      }
      case "retarget_collection": {
        const r = resolveCollectionRef(change.ref, allowed.map((c) => ({ id: c.id, name: c.name })));
        if (!("match" in r)) {
          throw new UserFacingError(
            "ambiguous" in r
              ? `«${change.ref}» è ambiguo: ${r.ambiguous.map((c) => c.name).join(", ")}`
              : `collection «${change.ref}» non collegata a questo canale (vedi \`@${config.MM_BOT_USERNAME} collezioni\`)`,
          );
        }
        payload.target = {
          action: "create",
          collectionId: r.match.id,
          collectionName: r.match.name,
          documentId: null,
          documentTitle: t.action === "create" ? t.documentTitle : payload.hint || t.documentTitle,
          documentUrl: null,
          parentDocumentId: null,
          path: [],
        };
        break;
      }
    }

    // A rename doesn't need new content; everything else is re-drafted.
    if (change.kind !== "rename") {
      await mmClient
        .updatePost(proposal.bot_reply_post_id, `🔄 Rigenero la proposta #${proposal.id}…`)
        .catch(() => undefined);
      payload.confidence = 1;
      payload.reasoning = "destinazione/istruzioni indicate dall'utente";
      payload.alternatives = [];
      await draftForTarget(payload, ctx, trees);
    }

    updateProposalPayload(proposal.id, JSON.stringify(payload), expiresAt());
    setProposalStatus(proposal.id, "pending");
    await mmClient.updatePost(proposal.bot_reply_post_id, renderProposal(proposal.id, payload));
    await reply(`🔁 Proposta #${proposal.id} aggiornata — vedi il messaggio sopra e conferma con 👍 o \`ok\`.`);
    logger.info({ proposal_id: proposal.id, change: change.kind }, "proposal_revised");
  } catch (err) {
    logger.warn({ err, proposal_id: proposal.id }, "proposal_revise_failed");
    setProposalStatus(proposal.id, "pending");
    // Restore the previous preview (we may have replaced it with a progress message).
    const fresh = findProposalById(proposal.id);
    if (fresh) {
      await mmClient.updatePost(fresh.bot_reply_post_id, renderProposal(fresh.id, loadPayload(fresh))).catch(() => undefined);
    }
    await reply(`⚠️ ${formatUserError(err)}`).catch(() => undefined);
  }
}

export async function markProposalExpired(proposal: SaveProposalRow, mmClient: MattermostClient): Promise<void> {
  const payload = loadPayload(proposal);
  await mmClient.updatePost(
    proposal.bot_reply_post_id,
    renderProposal(proposal.id, payload, `⌛ **Proposta #${proposal.id} scaduta** — nessuna modifica applicata. Ripeti \`salva\` se serve.`),
  );
}
