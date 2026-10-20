import type { OutlineClient } from "../outline/client.js";
import { listAllDocuments } from "../outline/documents.js";
import { chunkDocument } from "./chunker.js";
import { embed } from "../embedding/client.js";
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

const EMBED_BATCH = 8;

export async function indexDocument(
  client: OutlineClient,
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

  const chunks = chunkDocument(docText, docTitle);
  if (chunks.length === 0) {
    deleteChunksStmt.run(docId);
    upsertStateStmt.run(docId, docRevision);
    return true;
  }

  // Embed in batches
  const embeddings: number[][] = [];
  for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
    const batch = chunks.slice(i, i + EMBED_BATCH).map((c) => `${c.heading}\n${c.content}`);
    const vecs = await embed(batch);
    embeddings.push(...vecs);
  }

  const tx = db.transaction(() => {
    deleteChunksStmt.run(docId);
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i]!;
      insertChunkStmt.run(
        docId,
        docTitle,
        docUrl,
        collectionId,
        c.chunkIndex,
        c.heading,
        c.content,
        JSON.stringify(embeddings[i] ?? [])
      );
    }
    upsertStateStmt.run(docId, docRevision);
  });
  tx();

  logger.info({ docId, docTitle, chunks: chunks.length }, "document_indexed");
  return true;
}

export async function runFullSync(client: OutlineClient): Promise<void> {
  logger.info("outline_index_sync_start");
  let indexed = 0;
  let skipped = 0;
  const seen = new Set<string>();

  for await (const doc of listAllDocuments(client)) {
    seen.add(doc.id);
    try {
      const changed = await indexDocument(client, doc.id, doc.title, doc.text ?? "", doc.revision ?? 0, doc.url ?? "", doc.collectionId ?? "");
      if (changed) indexed++; else skipped++;
    } catch (err) {
      logger.warn({ err, docId: doc.id, docTitle: doc.title }, "index_doc_failed");
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

  logger.info({ indexed, skipped, pruned }, "outline_index_sync_done");
}

export function removeDocumentFromIndex(docId: string): void {
  db.transaction(() => {
    deleteChunksStmt.run(docId);
    deleteStateStmt.run(docId);
  })();
}
