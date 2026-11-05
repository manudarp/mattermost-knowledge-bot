import { createHash } from "node:crypto";
import type { OutlineClient } from "../outline/client.js";
import { getDocument, listDocuments, type OutlineDocument } from "../outline/documents.js";
import { HttpError } from "../utils/retry.js";
import { chunkDocument, embeddingText } from "./chunker.js";
import { embed, embeddingModelId } from "../embedding/client.js";
import { vectorToBlob } from "../search/vectors.js";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { logger } from "../logger.js";

interface IndexState {
  doc_revision: number;
  doc_updated_at: string | null;
  text_hash: string | null;
}
const getStateStmt = db.prepare<[string], IndexState>(
  "SELECT doc_revision, doc_updated_at, text_hash FROM index_state WHERE doc_id = ?"
);
const upsertStateStmt = db.prepare(
  `INSERT INTO index_state (doc_id, doc_revision, doc_updated_at, text_hash) VALUES (?, ?, ?, ?)
   ON CONFLICT(doc_id) DO UPDATE SET doc_revision = excluded.doc_revision, doc_updated_at = excluded.doc_updated_at,
     text_hash = excluded.text_hash, indexed_at = datetime('now')`
);
const markCheckedStmt = db.prepare(
  "UPDATE index_state SET doc_updated_at = COALESCE(?, doc_updated_at), text_hash = ? WHERE doc_id = ?"
);
const indexedCharsStmt = db.prepare<[string], { n: number | null }>(
  "SELECT SUM(length(content)) AS n FROM document_chunks WHERE doc_id = ?"
);
const deleteChunksStmt = db.prepare("DELETE FROM document_chunks WHERE doc_id = ?");
const deleteStateStmt = db.prepare("DELETE FROM index_state WHERE doc_id = ?");
const allIndexedDocIdsStmt = db.prepare<[], { doc_id: string }>("SELECT doc_id FROM index_state");
// Moving a document between collections doesn't bump its revision; keep the
// chunk metadata in sync so collection-scoped search stays correct.
const syncChunkMetaStmt = db.prepare(
  "UPDATE document_chunks SET collection_id = ?, doc_title = ?, doc_url = ? WHERE doc_id = ? AND (collection_id <> ? OR doc_title <> ? OR doc_url <> ?)"
);
const insertChunkStmt = db.prepare(
  "INSERT INTO document_chunks (doc_id, doc_title, doc_url, collection_id, chunk_index, heading, content, embedding) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
);
const getSettingStmt = db.prepare<[string], { value: string }>("SELECT value FROM bot_settings WHERE key = ?");
const setSettingStmt = db.prepare(
  "INSERT INTO bot_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
);
const countChunksStmt = db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM document_chunks");

/**
 * Vectors from different embedding models are not comparable. When the
 * configured model differs from the one that built the index, drop everything
 * so the next sync rebuilds it consistently.
 */
export function ensureIndexMatchesEmbeddingModel(): void {
  const current = embeddingModelId();
  const stored = getSettingStmt.get("embedding_model")?.value;
  if (stored === current) return;
  const chunks = countChunksStmt.get()?.n ?? 0;
  db.transaction(() => {
    db.prepare("DELETE FROM document_chunks").run();
    db.prepare("DELETE FROM index_state").run();
    setSettingStmt.run("embedding_model", current);
  })();
  logger.warn({ previous: stored ?? null, current, dropped_chunks: chunks }, "embedding_model_changed_index_reset");
}

function textHash(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

/**
 * True when the existing chunks plausibly cover the full text. Used once per
 * document indexed before text hashes existed: older versions could index the
 * truncated text of documents.list when documents.info was rate limited.
 */
function chunksCoverText(docId: string, text: string): boolean {
  const indexed = indexedCharsStmt.get(docId)?.n ?? 0;
  const plain = text.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/^#{1,6}\s.*$/gm, "").replace(/\s+/g, " ").trim();
  return plain.length === 0 || indexed >= plain.length * 0.5;
}

export async function indexDocument(
  _client: OutlineClient,
  docId: string,
  docTitle: string,
  docText: string,
  docRevision: number,
  docUrl: string,
  collectionId = "",
  updatedAt: string | null = null,
  opts: { force?: boolean } = {},
): Promise<boolean> {
  const hash = textHash(docText);
  const state = getStateStmt.get(docId);
  if (!opts.force && state && state.doc_revision === docRevision) {
    const sameText = state.text_hash === hash || (state.text_hash === null && chunksCoverText(docId, docText));
    if (sameText) {
      markCheckedStmt.run(updatedAt, hash, docId);
      if (collectionId) {
        syncChunkMetaStmt.run(collectionId, docTitle, docUrl, docId, collectionId, docTitle, docUrl);
      }
      return false; // already up to date
    }
    logger.info({ docId, docTitle }, "document_reindex_incomplete_text");
  }

  const t0 = Date.now();
  const chunks = chunkDocument(docText, docTitle, {
    maxChars: config.CHUNK_MAX_CHARS,
    overlapChars: config.CHUNK_OVERLAP_CHARS,
  });
  if (chunks.length === 0) {
    db.transaction(() => {
      deleteChunksStmt.run(docId);
      upsertStateStmt.run(docId, docRevision, updatedAt, hash);
    })();
    return true;
  }

  const embeddings: number[][] = [];
  const batch = config.EMBEDDING_BATCH_SIZE;
  for (let i = 0; i < chunks.length; i += batch) {
    const texts = chunks.slice(i, i + batch).map((c) => embeddingText(docTitle, c));
    embeddings.push(...(await embed(texts)));
    if (chunks.length > batch * 4) {
      logger.debug({ docTitle, done: Math.min(i + batch, chunks.length), total: chunks.length }, "document_index_progress");
    }
  }

  db.transaction(() => {
    deleteChunksStmt.run(docId);
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i]!;
      insertChunkStmt.run(docId, docTitle, docUrl, collectionId, c.chunkIndex, c.heading, c.content, vectorToBlob(embeddings[i] ?? []));
    }
    upsertStateStmt.run(docId, docRevision, updatedAt, hash);
  })();

  logger.info({ docId, docTitle, chunks: chunks.length, ms: Date.now() - t0 }, "document_indexed");
  return true;
}

/** Unchanged since the last sync according to documents.list → no need to download it. */
function unchangedSinceLastSync(doc: OutlineDocument): boolean {
  if (!doc.updatedAt) return false;
  const state = getStateStmt.get(doc.id);
  return !!state && state.doc_updated_at === doc.updatedAt && state.text_hash !== null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface SyncStats {
  force: boolean;
  startedAt: string;
  finishedAt: string | null;
  seen: number;
  indexed: number;
  skipped: number;
  failed: number;
  pruned: number;
  /** First few documents that could not be indexed, for the chat report. */
  failures: Array<{ id: string; title: string; error: string }>;
  /** Set when the whole sync aborted (e.g. Outline unreachable). */
  error: string | null;
}

const MAX_REPORTED_FAILURES = 10;
const LAST_SYNC_KEY = "last_index_sync";

let currentSync: Promise<SyncStats> | null = null;
let progress: SyncStats | null = null;

/** Live counters of the running sync, or null when idle. */
export function currentSyncProgress(): SyncStats | null {
  return progress ? { ...progress, failures: [...progress.failures] } : null;
}

/** Result of the last completed sync (persisted across restarts). */
export function lastSyncResult(): SyncStats | null {
  const raw = getSettingStmt.get(LAST_SYNC_KEY)?.value;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SyncStats;
  } catch {
    return null;
  }
}

export function indexStats(): { documents: number; chunks: number } {
  const documents = (db.prepare("SELECT COUNT(*) AS n FROM index_state").get() as { n: number }).n;
  return { documents, chunks: countChunksStmt.get()?.n ?? 0 };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Re-indexes every changed document. Only one sync runs at a time: with a slow
 * embedding backend a sync can outlast the interval, and overlapping runs would
 * compete for the same CPU and never finish. A call made while a sync is
 * running gets that sync's result.
 *
 * `force` downloads and re-embeds every document, ignoring change detection.
 */
export function runFullSync(client: OutlineClient, opts: { force?: boolean } = {}): Promise<SyncStats> {
  if (currentSync) {
    logger.info("outline_index_sync_skipped_already_running");
    return currentSync;
  }
  currentSync = doFullSync(client, opts.force ?? false).finally(() => {
    currentSync = null;
    progress = null;
  });
  return currentSync;
}

/**
 * True when Outline confirms the document is gone (deleted, archived or no
 * longer readable by the bot). Any other error keeps it in the index: a
 * document missed by the paginated listing (the list shifts while a long sync
 * runs) must not be dropped and re-embedded on the next sync.
 */
async function confirmedGone(client: OutlineClient, docId: string): Promise<boolean> {
  try {
    const doc = await getDocument(client, docId);
    return !!(doc.deletedAt || doc.archivedAt);
  } catch (err) {
    return err instanceof HttpError && [400, 403, 404].includes(err.status);
  }
}

async function doFullSync(client: OutlineClient, force: boolean): Promise<SyncStats> {
  const t0 = Date.now();
  const stats: SyncStats = {
    force,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    seen: 0,
    indexed: 0,
    skipped: 0,
    failed: 0,
    pruned: 0,
    failures: [],
    error: null,
  };
  progress = stats;
  logger.info({ force }, "outline_index_sync_start");
  const seen = new Set<string>();

  try {
    for await (const meta of listDocuments(client)) {
      if (seen.has(meta.id)) continue; // the list shifted under us
      seen.add(meta.id);
      stats.seen = seen.size;
      try {
        if (!force && unchangedSinceLastSync(meta)) {
          syncChunkMetaStmt.run(meta.collectionId ?? "", meta.title, meta.url ?? "", meta.id, meta.collectionId ?? "", meta.title, meta.url ?? "");
          stats.skipped++;
        } else {
          // Only changed (or never indexed) documents are downloaded, one at a
          // time with a pause, to stay under Outline's rate limiter. A failed
          // download is skipped and retried on the next sync — never indexed
          // from the truncated text of the list.
          if (config.OUTLINE_REQUEST_DELAY_MS > 0) await sleep(config.OUTLINE_REQUEST_DELAY_MS);
          const doc = await getDocument(client, meta.id);
          const changed = await indexDocument(
            client, doc.id, doc.title, doc.text ?? "", doc.revision ?? 0, doc.url ?? "",
            doc.collectionId ?? meta.collectionId ?? "", meta.updatedAt ?? doc.updatedAt ?? null,
            { force },
          );
          if (changed) stats.indexed++; else stats.skipped++;
        }
      } catch (err) {
        stats.failed++;
        if (stats.failures.length < MAX_REPORTED_FAILURES) {
          stats.failures.push({ id: meta.id, title: meta.title, error: errorText(err) });
        }
        logger.warn({ err, docId: meta.id, docTitle: meta.title }, "index_doc_failed");
      }
      if (seen.size % 25 === 0) {
        logger.info(
          { seen: seen.size, indexed: stats.indexed, skipped: stats.skipped, failed: stats.failed, minutes: Math.round((Date.now() - t0) / 60_000) },
          "outline_index_sync_progress",
        );
      }
    }

    // Anything indexed but not listed was probably deleted, archived or made
    // inaccessible in Outline. Drop it once Outline confirms, so it can't be
    // cited or proposed as a save target.
    for (const { doc_id } of allIndexedDocIdsStmt.all()) {
      if (seen.has(doc_id)) continue;
      if (config.OUTLINE_REQUEST_DELAY_MS > 0) await sleep(config.OUTLINE_REQUEST_DELAY_MS);
      if (await confirmedGone(client, doc_id)) {
        removeDocumentFromIndex(doc_id);
        stats.pruned++;
      }
    }
  } catch (err) {
    // Listing failed (Outline down, token revoked…): keep the index as it is.
    stats.error = errorText(err);
    logger.error({ err }, "outline_index_sync_failed");
  }

  stats.finishedAt = new Date().toISOString();
  setSettingStmt.run(LAST_SYNC_KEY, JSON.stringify(stats));
  logger.info(
    {
      force,
      indexed: stats.indexed,
      skipped: stats.skipped,
      failed: stats.failed,
      pruned: stats.pruned,
      error: stats.error,
      minutes: Math.round(((Date.now() - t0) / 60_000) * 10) / 10,
    },
    "outline_index_sync_done",
  );
  return stats;
}

/** Downloads one document and re-indexes it now. `ref` is a UUID or urlId. */
export async function indexSingleDocument(
  client: OutlineClient,
  ref: string,
): Promise<{ doc: OutlineDocument; chunks: number }> {
  const doc = await getDocument(client, ref);
  await indexDocument(
    client, doc.id, doc.title, doc.text ?? "", doc.revision ?? 0, doc.url ?? "",
    doc.collectionId ?? "", doc.updatedAt ?? null, { force: true },
  );
  const chunks = (db.prepare("SELECT COUNT(*) AS n FROM document_chunks WHERE doc_id = ?").get(doc.id) as { n: number }).n;
  return { doc, chunks };
}

export function removeDocumentFromIndex(docId: string): void {
  db.transaction(() => {
    deleteChunksStmt.run(docId);
    deleteStateStmt.run(docId);
  })();
}
