import type { OutlineClient } from "../outline/client.js";
import { listAllDocuments } from "../outline/documents.js";
import { chunkDocument, embeddingText } from "./chunker.js";
import { embed, embeddingModelId } from "../embedding/client.js";
import { vectorToBlob } from "../search/vectors.js";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { logger } from "../logger.js";

const getStateStmt = db.prepare<[string], { doc_revision: number }>(
  "SELECT doc_revision FROM index_state WHERE doc_id = ?"
);
const upsertStateStmt = db.prepare(
  "INSERT INTO index_state (doc_id, doc_revision) VALUES (?, ?) ON CONFLICT(doc_id) DO UPDATE SET doc_revision = excluded.doc_revision, indexed_at = datetime('now')"
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

export async function indexDocument(
  _client: OutlineClient,
  docId: string,
  docTitle: string,
  docText: string,
  docRevision: number,
  docUrl: string,
  collectionId = ""
): Promise<boolean> {
  const state = getStateStmt.get(docId);
  if (state && state.doc_revision === docRevision) {
    if (collectionId) {
      syncChunkMetaStmt.run(collectionId, docTitle, docUrl, docId, collectionId, docTitle, docUrl);
    }
    return false; // already up to date
  }

  const t0 = Date.now();
  const chunks = chunkDocument(docText, docTitle, {
    maxChars: config.CHUNK_MAX_CHARS,
    overlapChars: config.CHUNK_OVERLAP_CHARS,
  });
  if (chunks.length === 0) {
    db.transaction(() => {
      deleteChunksStmt.run(docId);
      upsertStateStmt.run(docId, docRevision);
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
    upsertStateStmt.run(docId, docRevision);
  })();

  logger.info({ docId, docTitle, chunks: chunks.length, ms: Date.now() - t0 }, "document_indexed");
  return true;
}

let currentSync: Promise<void> | null = null;

/**
 * Re-indexes every changed document. Only one sync runs at a time: with a slow
 * embedding backend a sync can outlast the interval, and overlapping runs would
 * compete for the same CPU and never finish.
 */
export function runFullSync(client: OutlineClient): Promise<void> {
  if (currentSync) {
    logger.info("outline_index_sync_skipped_already_running");
    return currentSync;
  }
  currentSync = doFullSync(client).finally(() => {
    currentSync = null;
  });
  return currentSync;
}

async function doFullSync(client: OutlineClient): Promise<void> {
  const t0 = Date.now();
  logger.info("outline_index_sync_start");
  let indexed = 0;
  let skipped = 0;
  let failed = 0;
  const seen = new Set<string>();

  for await (const doc of listAllDocuments(client)) {
    seen.add(doc.id);
    try {
      const changed = await indexDocument(client, doc.id, doc.title, doc.text ?? "", doc.revision ?? 0, doc.url ?? "", doc.collectionId ?? "");
      if (changed) indexed++; else skipped++;
    } catch (err) {
      failed++;
      logger.warn({ err, docId: doc.id, docTitle: doc.title }, "index_doc_failed");
    }
    if (seen.size % 25 === 0) {
      logger.info({ seen: seen.size, indexed, skipped, failed, minutes: Math.round((Date.now() - t0) / 60_000) }, "outline_index_sync_progress");
    }
  }

  // Listing completed without throwing → anything not seen was deleted,
  // archived or made inaccessible in Outline. Drop it from the index so it
  // can't be cited or proposed as a save target.
  let pruned = 0;
  for (const { doc_id } of allIndexedDocIdsStmt.all()) {
    if (!seen.has(doc_id)) {
      removeDocumentFromIndex(doc_id);
      pruned++;
    }
  }

  logger.info(
    { indexed, skipped, failed, pruned, minutes: Math.round(((Date.now() - t0) / 60_000) * 10) / 10 },
    "outline_index_sync_done",
  );
}

export function removeDocumentFromIndex(docId: string): void {
  db.transaction(() => {
    deleteChunksStmt.run(docId);
    deleteStateStmt.run(docId);
  })();
}
