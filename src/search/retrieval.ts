import { db } from "../db/index.js";
import { embedOne } from "../embedding/client.js";

export interface RetrievedChunk {
  docId: string;
  docTitle: string;
  docUrl: string;
  collectionId: string;
  heading: string;
  content: string;
  score: number;
}

interface ChunkRow {
  doc_id: string;
  doc_title: string;
  doc_url: string;
  collection_id: string;
  heading: string;
  content: string;
  embedding: string;
}

export interface SearchScope {
  /** Restrict to these Outline collections (e.g. the ones linked to a channel). */
  collectionIds?: string[];
  docPath?: string;       // Outline doc path, e.g. /doc/title-abc123
  collectionId?: string;  // Outline collection UUID
}

const COLUMNS = "doc_id, doc_title, doc_url, collection_id, heading, content, embedding";

// Global retrieval — every chunk in the vector store.
const allChunksStmt = db.prepare<[], ChunkRow>(`SELECT ${COLUMNS} FROM document_chunks`);

// Outline page-context retrieval
const chunksByDocPathStmt = db.prepare<[string], ChunkRow>(
  `SELECT ${COLUMNS} FROM document_chunks WHERE doc_url LIKE '%' || ?`,
);
const chunksByCollectionStmt = db.prepare<[string], ChunkRow>(
  `SELECT ${COLUMNS} FROM document_chunks WHERE collection_id = ?`,
);

function chunksByCollections(ids: string[]): ChunkRow[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  return db
    .prepare<string[], ChunkRow>(`SELECT ${COLUMNS} FROM document_chunks WHERE collection_id IN (${placeholders})`)
    .all(...ids);
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    magA += (a[i] ?? 0) * (a[i] ?? 0);
    magB += (b[i] ?? 0) * (b[i] ?? 0);
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

function rowsForScope(scope?: SearchScope): ChunkRow[] {
  if (scope?.collectionIds) return chunksByCollections(scope.collectionIds);
  if (scope?.docPath) return chunksByDocPathStmt.all(scope.docPath);
  if (scope?.collectionId) return chunksByCollectionStmt.all(scope.collectionId);
  return allChunksStmt.all();
}

function scoreRows(queryVec: number[], rows: ChunkRow[]): RetrievedChunk[] {
  return rows.map((row) => ({
    docId: row.doc_id,
    docTitle: row.doc_title,
    docUrl: row.doc_url,
    collectionId: row.collection_id,
    heading: row.heading,
    content: row.content,
    score: cosine(queryVec, JSON.parse(row.embedding) as number[]),
  }));
}

export async function search(
  query: string,
  topK = 5,
  scope?: SearchScope,
): Promise<RetrievedChunk[]> {
  const queryVec = await embedOne(query);
  const scored = scoreRows(queryVec, rowsForScope(scope));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

export interface RetrievedDocument {
  docId: string;
  docTitle: string;
  docUrl: string;
  collectionId: string;
  score: number;
  /** All indexed section headings of the document, in order. */
  headings: string[];
  /** Best-matching chunks, highest first. */
  bestChunks: Array<{ heading: string; content: string; score: number }>;
}

/** Document-level retrieval: chunks grouped per document, ranked by best chunk. */
export async function searchDocuments(
  query: string,
  topDocs: number,
  scope?: SearchScope,
): Promise<RetrievedDocument[]> {
  const queryVec = await embedOne(query);
  const scored = scoreRows(queryVec, rowsForScope(scope));

  const byDoc = new Map<string, RetrievedDocument>();
  for (const c of scored) {
    let d = byDoc.get(c.docId);
    if (!d) {
      d = {
        docId: c.docId,
        docTitle: c.docTitle,
        docUrl: c.docUrl,
        collectionId: c.collectionId,
        score: 0,
        headings: [],
        bestChunks: [],
      };
      byDoc.set(c.docId, d);
    }
    d.headings.push(c.heading);
    d.bestChunks.push({ heading: c.heading, content: c.content, score: c.score });
    d.score = Math.max(d.score, c.score);
  }

  const docs = [...byDoc.values()].sort((a, b) => b.score - a.score).slice(0, topDocs);
  for (const d of docs) {
    d.bestChunks.sort((a, b) => b.score - a.score);
    d.bestChunks = d.bestChunks.slice(0, 2);
  }
  return docs;
}
