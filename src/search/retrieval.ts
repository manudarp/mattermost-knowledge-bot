import { db } from "../db/index.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { embedOne } from "../embedding/client.js";
import { blobToVector, cosine } from "./vectors.js";

/**
 * Hybrid retrieval: semantic similarity (embeddings) + keyword match (SQLite
 * FTS5 / BM25), merged with Reciprocal Rank Fusion. Embeddings capture
 * paraphrases; keywords catch exact technical terms ("SOAP", "WSDL", table
 * names) that embeddings tend to blur. If the embedding backend is down,
 * search degrades to keywords only instead of failing.
 */

export interface RetrievedChunk {
  docId: string;
  docTitle: string;
  docUrl: string;
  collectionId: string;
  heading: string;
  content: string;
  /** Cosine similarity with the query (0 when embeddings were unavailable). */
  score: number;
  /** 1-based position in the keyword ranking, null when no keyword matched. */
  keywordRank: number | null;
}

interface ChunkRow {
  id: number;
  doc_id: string;
  doc_title: string;
  doc_url: string;
  collection_id: string;
  heading: string;
  content: string;
  embedding: Buffer;
}

export interface SearchScope {
  /** Restrict to these Outline collections (e.g. the ones linked to a channel). */
  collectionIds?: string[];
  docPath?: string;       // Outline doc path, e.g. /doc/title-abc123
  collectionId?: string;  // Outline collection UUID
}

const COLUMNS = "dc.id, dc.doc_id, dc.doc_title, dc.doc_url, dc.collection_id, dc.heading, dc.content, dc.embedding";
const RRF_K = 60;
const CANDIDATES = 50;
/** Keyword hits ranked this high count as relevant even with a low cosine score. */
const KEYWORD_RELEVANT_RANK = 10;

function scopeFilter(scope?: SearchScope): { sql: string; params: string[] } {
  if (scope?.collectionIds) {
    if (scope.collectionIds.length === 0) return { sql: " AND 0", params: [] };
    return { sql: ` AND dc.collection_id IN (${scope.collectionIds.map(() => "?").join(",")})`, params: scope.collectionIds };
  }
  if (scope?.docPath) return { sql: " AND dc.doc_url LIKE '%' || ?", params: [scope.docPath] };
  if (scope?.collectionId) return { sql: " AND dc.collection_id = ?", params: [scope.collectionId] };
  return { sql: "", params: [] };
}

// Very common Italian/English words carry no retrieval signal.
const STOPWORDS = new Set(
  (
    "il lo la i gli le un uno una di da in con su per tra fra a e o ed od ma se che chi cui non come dove quando " +
    "quale quali quanto cosa sono sei siamo siete è era ho hai ha abbiamo hanno del della dei delle degli dello al " +
    "allo alla ai agli alle dal dalla dai dalle nel nella nei nelle sul sulla sui sulle questo questa questi queste " +
    "quello quella mi ti ci vi si ne anche più molto tutto tutti poi qui là " +
    "the a an of to in on for and or is are was be how what which who where when with from by this that it as at"
  ).split(/\s+/),
);

/** Builds an FTS5 MATCH expression (OR of quoted terms, prefix match for longer ones). */
export function ftsQuery(query: string): string | null {
  const terms = [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((t) => (t.length >= 3 || /\d/.test(t)) && t.length <= 40 && !STOPWORDS.has(t)),
    ),
  ].slice(0, 16);
  if (terms.length === 0) return null;
  return terms.map((t) => (t.length >= 5 ? `"${t}"*` : `"${t}"`)).join(" OR ");
}

function keywordCandidates(query: string, scope: SearchScope | undefined, limit: number): ChunkRow[] {
  const match = ftsQuery(query);
  if (!match) return [];
  const filter = scopeFilter(scope);
  try {
    return db
      .prepare<unknown[], ChunkRow>(
        `SELECT ${COLUMNS}
         FROM chunks_fts JOIN document_chunks dc ON dc.id = chunks_fts.rowid
         WHERE chunks_fts MATCH ?${filter.sql}
         ORDER BY bm25(chunks_fts, 2.0, 3.0, 1.0)
         LIMIT ?`,
      )
      .all(match, ...filter.params, limit);
  } catch (err) {
    logger.warn({ err, match }, "keyword_search_failed");
    return [];
  }
}

function scopeRows(scope?: SearchScope): ChunkRow[] {
  const filter = scopeFilter(scope);
  return db.prepare<unknown[], ChunkRow>(`SELECT ${COLUMNS} FROM document_chunks dc WHERE 1${filter.sql}`).all(...filter.params);
}

interface Ranked {
  row: ChunkRow;
  score: number;
  keywordRank: number | null;
  fused: number;
}

async function rankHybrid(query: string, scope: SearchScope | undefined): Promise<Ranked[]> {
  let queryVec: number[] | null = null;
  try {
    queryVec = await embedOne(query);
  } catch (err) {
    logger.warn({ err }, "query_embedding_failed_keyword_only");
  }

  const byId = new Map<number, Ranked>();
  const entry = (row: ChunkRow): Ranked => {
    let e = byId.get(row.id);
    if (!e) {
      e = { row, score: queryVec ? cosine(queryVec, blobToVector(row.embedding)) : 0, keywordRank: null, fused: 0 };
      byId.set(row.id, e);
    }
    return e;
  };

  if (queryVec) {
    const vectorRanked = scopeRows(scope)
      .map(entry)
      .sort((a, b) => b.score - a.score)
      .slice(0, CANDIDATES);
    vectorRanked.forEach((e, i) => (e.fused += 1 / (RRF_K + i + 1)));
  }

  keywordCandidates(query, scope, CANDIDATES).forEach((row, i) => {
    const e = entry(row);
    e.keywordRank = i + 1;
    e.fused += 1 / (RRF_K + i + 1);
  });

  return [...byId.values()].filter((e) => e.fused > 0).sort((a, b) => b.fused - a.fused);
}

function toChunk(e: Ranked): RetrievedChunk {
  return {
    docId: e.row.doc_id,
    docTitle: e.row.doc_title,
    docUrl: e.row.doc_url,
    collectionId: e.row.collection_id,
    heading: e.row.heading,
    content: e.row.content,
    score: e.score,
    keywordRank: e.keywordRank,
  };
}

export interface SearchOptions {
  /** Minimum cosine similarity; strong keyword matches pass regardless. */
  minScore?: number;
  maxPerDoc?: number;
}

/** Relevant chunks for a question, best first. Returns [] when nothing is relevant. */
export async function search(
  query: string,
  topK = config.SEARCH_TOP_K,
  scope?: SearchScope,
  opts: SearchOptions = {},
): Promise<RetrievedChunk[]> {
  const minScore = opts.minScore ?? config.SEARCH_SCORE_THRESHOLD;
  const maxPerDoc = opts.maxPerDoc ?? config.SEARCH_MAX_CHUNKS_PER_DOC;

  const perDoc = new Map<string, number>();
  const out: RetrievedChunk[] = [];
  for (const e of await rankHybrid(query, scope)) {
    const relevant = e.score >= minScore || (e.keywordRank !== null && e.keywordRank <= KEYWORD_RELEVANT_RANK);
    if (!relevant) continue;
    const n = perDoc.get(e.row.doc_id) ?? 0;
    if (n >= maxPerDoc) continue;
    perDoc.set(e.row.doc_id, n + 1);
    out.push(toChunk(e));
    if (out.length >= topK) break;
  }
  return out;
}

export interface RetrievedDocument {
  docId: string;
  docTitle: string;
  docUrl: string;
  collectionId: string;
  score: number;
  /** Indexed section headings of the document, in order. */
  headings: string[];
  /** Best-matching chunks, highest first. */
  bestChunks: Array<{ heading: string; content: string; score: number }>;
}

const headingsForDocStmt = db.prepare<[string], { heading: string }>(
  "SELECT heading FROM document_chunks WHERE doc_id = ? ORDER BY chunk_index",
);

/** Document-level retrieval (used to propose where to save): chunks grouped per document. */
export async function searchDocuments(
  query: string,
  topDocs: number,
  scope?: SearchScope,
): Promise<RetrievedDocument[]> {
  const byDoc = new Map<string, RetrievedDocument>();
  for (const e of await rankHybrid(query, scope)) {
    let d = byDoc.get(e.row.doc_id);
    if (!d) {
      if (byDoc.size >= topDocs) continue;
      d = {
        docId: e.row.doc_id,
        docTitle: e.row.doc_title,
        docUrl: e.row.doc_url,
        collectionId: e.row.collection_id,
        score: 0,
        headings: [],
        bestChunks: [],
      };
      byDoc.set(e.row.doc_id, d);
    }
    d.score = Math.max(d.score, e.score);
    if (d.bestChunks.length < 2) d.bestChunks.push({ heading: e.row.heading, content: e.row.content, score: e.score });
  }
  for (const d of byDoc.values()) {
    d.headings = [...new Set(headingsForDocStmt.all(d.docId).map((h) => h.heading))];
  }
  return [...byDoc.values()];
}
