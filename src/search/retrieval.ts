import { db } from "../db/index.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { embedQuery } from "../embedding/client.js";
import { blobToVector, cosine } from "./vectors.js";
import { containsPhrase, expandQuery, normalize, type GlossaryEntry } from "./glossary.js";
import { rerankPassages, rerankThreshold } from "./rerank.js";
import { decomposeQuery, shouldDecompose } from "./decompose.js";

/**
 * Hybrid retrieval: semantic similarity (embeddings) + keyword match (SQLite
 * FTS5 / BM25), merged with Reciprocal Rank Fusion. Embeddings capture
 * paraphrases; keywords catch exact technical terms ("SOAP", "WSDL", table
 * names) that embeddings tend to blur. If the embedding backend is down,
 * search degrades to keywords only instead of failing.
 *
 * For questions, three filters keep marginal passages out of the answer:
 *  1. semantic matches must be close to the best one (SEARCH_RELATIVE_MARGIN);
 *  2. keyword matches must contain enough of the query's distinctive terms
 *     (SEARCH_KEYWORD_MIN_COVERAGE), not just one generic word;
 *  3. optionally the LLM re-ranks the survivors (SEARCH_RERANK).
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
/** Keyword hits ranked this high may count as relevant even with a low cosine score. */
const KEYWORD_RELEVANT_RANK = 10;
const MAX_QUERY_TERMS = 16;
/** A query term found in at most this share of chunks counts as rare (never in a tiny index). */
const RARE_TERM_SHARE = 0.003;
/** Rare-term passages kept even when the re-ranker rejects them. */
const MAX_PROTECTED = 2;
/** When the re-ranker keeps nothing, the best few with a non-zero score still reach the answer. */
const RERANK_FALLBACK = 3;

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

function tokens(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function queryTerms(query: string): string[] {
  return [
    ...new Set(tokens(query).filter((t) => (t.length >= 3 || /\d/.test(t)) && t.length <= 40 && !STOPWORDS.has(t))),
  ].slice(0, MAX_QUERY_TERMS);
}

/**
 * A unit of meaning in the query: a single distinctive word, or a glossary
 * entry (any of its aliases, e.g. "AHRW" or "Ad hoc Revolution Web").
 */
interface Concept {
  label: string;
  /** FTS5 expressions, OR-ed together. */
  fts: string[];
  matches: (normalizedText: string) => boolean;
  /** Lowercase forms to look for in a passage (stems, aliases), used to focus the re-ranker. */
  terms: string[];
}

function phraseExpr(alias: string): string | null {
  const t = tokens(alias);
  if (t.length === 0) return null;
  return `"${t.join(" ")}"`;
}

/**
 * Minimal Italian stemming for prefix search: drop the final vowel so that
 * singular and plural (ordine/ordini, vendita/vendite, documento/documenti)
 * share a prefix. Only for words of 5+ letters, leaving a stem of 4+.
 */
export function lightStem(word: string): string {
  return word.length >= 5 && /[aeiouàèéìòù]$/i.test(word) ? word.slice(0, -1) : word;
}

function buildConcepts(query: string, matched: GlossaryEntry[]): Concept[] {
  // Words that belong to a matched glossary alias are covered by that entry.
  const aliasWords = new Set(matched.flatMap((e) => e.aliases.flatMap((a) => tokens(a))));
  const singles: Concept[] = queryTerms(query)
    .filter((t) => !aliasWords.has(t))
    .map((t) => {
      const prefix = t.length >= 5;
      const stem = prefix ? lightStem(t) : t;
      const n = normalize(stem);
      const re = new RegExp(`(^|[^\\p{L}\\p{N}])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${prefix ? "" : "($|[^\\p{L}\\p{N}])"}`, "u");
      return { label: t, fts: [prefix ? `"${stem}"*` : `"${t}"`], matches: (text: string) => re.test(text), terms: [n] };
    });
  const entries: Concept[] = matched.map((e) => {
    const aliases = e.aliases.map(normalize);
    return {
      label: e.aliases[0]!,
      fts: e.aliases.map(phraseExpr).filter((x): x is string => x !== null),
      matches: (text: string) => aliases.some((a) => containsPhrase(text, a)),
      terms: aliases,
    };
  });
  return [...singles, ...entries];
}

/** Builds an FTS5 MATCH expression (OR of quoted terms, prefix match for longer ones). */
export function ftsQuery(query: string, matched: GlossaryEntry[] = []): string | null {
  const exprs = buildConcepts(query, matched).flatMap((c) => c.fts);
  return exprs.length > 0 ? exprs.join(" OR ") : null;
}

const countChunksStmt = db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM document_chunks");

/**
 * Rarity of each concept: IDF weight (concepts found nowhere weigh 0: they
 * can't discriminate) and whether it is rare enough to be an identifier-like
 * term ("TIPDOC", "AHRWTX_Docs") whose exact match is itself strong evidence.
 */
function conceptStats(concepts: Concept[]): Array<{ weight: number; rare: boolean }> {
  const total = countChunksStmt.get()?.n ?? 0;
  const rareMax = Math.floor(total * RARE_TERM_SHARE);
  return concepts.map((c) => {
    try {
      const df = (db.prepare("SELECT COUNT(*) AS n FROM chunks_fts WHERE chunks_fts MATCH ?").get(c.fts.join(" OR ")) as { n: number }).n;
      return df === 0 ? { weight: 0, rare: false } : { weight: Math.log(1 + total / df), rare: df <= rareMax };
    } catch {
      return { weight: 0, rare: false };
    }
  });
}

function coverageOf(row: ChunkRow, concepts: Concept[], weights: number[]): number {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum === 0) return 1;
  const text = normalize(`${row.doc_title} ${row.heading} ${row.content}`);
  let got = 0;
  concepts.forEach((c, i) => {
    if (c.matches(text)) got += weights[i]!;
  });
  return got / sum;
}

function keywordCandidates(match: string | null, scope: SearchScope | undefined, limit: number): ChunkRow[] {
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

interface HybridResult {
  ranked: Ranked[];
  semantic: boolean;
  topScore: number;
  concepts: Concept[];
  fts: string | null;
  embeddingQuery: string;
  glossaryNote: string;
}

async function rankHybrid(query: string, scope: SearchScope | undefined): Promise<HybridResult> {
  const expansion = expandQuery(query);
  const concepts = buildConcepts(query, expansion.matched);
  const fts = ftsQuery(query, expansion.matched);

  let queryVec: number[] | null = null;
  try {
    queryVec = await embedQuery(expansion.embeddingQuery);
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

  let topScore = 0;
  if (queryVec) {
    const vectorRanked = scopeRows(scope)
      .map(entry)
      .sort((a, b) => b.score - a.score)
      .slice(0, CANDIDATES);
    topScore = vectorRanked[0]?.score ?? 0;
    vectorRanked.forEach((e, i) => (e.fused += 1 / (RRF_K + i + 1)));
  }

  keywordCandidates(fts, scope, CANDIDATES).forEach((row, i) => {
    const e = entry(row);
    e.keywordRank = i + 1;
    e.fused += 1 / (RRF_K + i + 1);
  });

  return {
    ranked: [...byId.values()].filter((e) => e.fused > 0).sort((a, b) => b.fused - a.fused),
    semantic: queryVec !== null,
    topScore,
    concepts,
    fts,
    embeddingQuery: expansion.embeddingQuery,
    glossaryNote: expansion.note,
  };
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
  /** Let the LLM pick the passages that answer the question (default SEARCH_RERANK). */
  rerank?: boolean;
  /** Recent messages of the conversation, so the re-ranker understands follow-ups. */
  conversationHint?: string;
  /**
   * Previous question in the thread. A short follow-up ("e per gli acquisti?")
   * has too few words to search on its own, so it is searched together with it.
   */
  followUpOf?: string;
  /** Split multi-part questions / rewrite follow-ups with the LLM first (default SEARCH_DECOMPOSE). */
  decompose?: boolean;
}

export interface TraceCandidate {
  docTitle: string;
  heading: string;
  score: number;
  keywordRank: number | null;
  coverage: number;
  /** "semantica" / "parole chiave" when it passed, otherwise why it was dropped. */
  verdict: string;
  passed: boolean;
  rerankScore: number | null;
  selected: boolean;
  /** Sub-query that found it ("#1", "#2"…), when the question was split. */
  via: string | null;
}

export interface TracePass {
  /** "#1", "#2"… when the question was split into sub-queries, null otherwise. */
  label: string | null;
  query: string;
  embeddingQuery: string;
  fts: string | null;
  topScore: number;
  semanticFloor: number;
}

export interface SearchTrace {
  query: string;
  glossaryNote: string;
  semantic: boolean;
  minScore: number;
  /** split = searched as several sub-queries; single = one query; skipped = not worth an LLM call. */
  decomposition: "off" | "skipped" | "single" | "split" | "failed";
  decompositionError: string | null;
  passes: TracePass[];
  candidates: TraceCandidate[];
  rerank: "off" | "ok" | "failed";
  rerankError: string | null;
}

const MAX_TRACE = 45;

interface Evaluated {
  e: Ranked;
  /** Contains a rare query term (exact identifier-like match). */
  rare: boolean;
  coverage: number;
  ok: boolean;
  verdict: string;
}

function evaluate(hybrid: HybridResult, semanticFloor: number): Evaluated[] {
  const stats = conceptStats(hybrid.concepts);
  const weights = stats.map((s) => s.weight);
  const rareConcepts = hybrid.concepts.filter((_, i) => stats[i]!.rare);
  return hybrid.ranked.map((e) => {
    let coverage = 0;
    let rare = false;
    if (e.keywordRank !== null) {
      coverage = coverageOf(e.row, hybrid.concepts, weights);
      if (rareConcepts.length > 0) {
        const text = normalize(`${e.row.doc_title} ${e.row.heading} ${e.row.content}`);
        rare = rareConcepts.some((c) => c.matches(text));
      }
    }
    const semanticOk = hybrid.semantic && e.score >= semanticFloor;
    const strongKeyword = e.keywordRank !== null && e.keywordRank <= KEYWORD_RELEVANT_RANK;
    const keywordOk = strongKeyword && coverage >= config.SEARCH_KEYWORD_MIN_COVERAGE;
    const verdict = semanticOk
      ? "semantica"
      : keywordOk
        ? "parole chiave"
        : rare
          ? "termine raro"
          : strongKeyword
            ? "poche parole della domanda"
            : "poco simile";
    return { e, rare, coverage, ok: semanticOk || keywordOk || rare, verdict };
  });
}

/** Relevant chunks for a question, best first, with an explanation of every decision. */
export async function searchWithTrace(
  query: string,
  topK = config.SEARCH_TOP_K,
  scope?: SearchScope,
  opts: SearchOptions = {},
): Promise<{ chunks: RetrievedChunk[]; trace: SearchTrace; glossaryNote: string }> {
  const minScore = opts.minScore ?? config.SEARCH_SCORE_THRESHOLD;
  const maxPerDoc = opts.maxPerDoc ?? config.SEARCH_MAX_CHUNKS_PER_DOC;
  const rerank = opts.rerank ?? config.SEARCH_RERANK;
  const retrievalQuery = opts.followUpOf ? `${opts.followUpOf}\n${query}` : query;
  const glossaryNote = expandQuery(`${opts.followUpOf ?? ""}\n${query}`).note;

  // A multi-part question is split into self-contained sub-queries, each
  // searched on its own (see decompose.ts); a short follow-up is rewritten
  // into a complete question.
  let subQueries: Array<{ label: string | null; q: string }> = [{ label: null, q: retrievalQuery }];
  let decomposition: SearchTrace["decomposition"] = "off";
  let decompositionError: string | null = null;
  const decompose = opts.decompose ?? config.SEARCH_DECOMPOSE;
  if (decompose && shouldDecompose(query, !!opts.conversationHint)) {
    try {
      const queries = await decomposeQuery({ query, conversationHint: opts.conversationHint, glossaryNote });
      if (queries.length > 1) {
        subQueries = queries.map((q, i) => ({ label: `#${i + 1}`, q }));
        decomposition = "split";
      } else {
        // A rewritten follow-up replaces "previous question + follow-up";
        // a single self-contained question is searched as the user wrote it.
        if (opts.conversationHint && queries[0]) subQueries = [{ label: null, q: queries[0] }];
        decomposition = "single";
      }
    } catch (err) {
      decomposition = "failed";
      decompositionError = err instanceof Error ? err.message : String(err);
      logger.warn({ err }, "search_decompose_failed");
    }
  } else if (decompose) {
    decomposition = "skipped";
  }

  const passes: Array<{ info: TracePass; evaluated: Evaluated[]; semantic: boolean; terms: string[] }> = [];
  for (const sq of subQueries) {
    // Sequential: a local embedding server handles one request at a time anyway.
    const hybrid = await rankHybrid(sq.q, scope);
    const semanticFloor = Math.max(minScore, hybrid.topScore - config.SEARCH_RELATIVE_MARGIN);
    passes.push({
      info: { label: sq.label, query: sq.q, embeddingQuery: hybrid.embeddingQuery, fts: hybrid.fts, topScore: hybrid.topScore, semanticFloor },
      evaluated: evaluate(hybrid, semanticFloor),
      semantic: hybrid.semantic,
      terms: hybrid.concepts.flatMap((c) => c.terms),
    });
  }

  const trace: SearchTrace = {
    query,
    glossaryNote,
    decomposition,
    decompositionError,
    semantic: passes.some((p) => p.semantic),
    minScore,
    passes: passes.map((p) => p.info),
    candidates: [],
    rerank: "off",
    rerankError: null,
  };
  const addTrace = (ev: Evaluated, via: string | null, verdict: string, passed: boolean): TraceCandidate | null => {
    if (trace.candidates.length >= MAX_TRACE) return null;
    const t: TraceCandidate = {
      docTitle: ev.e.row.doc_title,
      heading: ev.e.row.heading,
      score: ev.e.score,
      keywordRank: ev.e.keywordRank,
      coverage: ev.coverage,
      verdict,
      passed,
      rerankScore: null,
      selected: false,
      via,
    };
    trace.candidates.push(t);
    return t;
  };

  // Merge the sub-searches round-robin so every product gets its share.
  const rerankCandidates = config.SEARCH_RERANK_CANDIDATES;
  const limit = rerank ? Math.max(topK, rerankCandidates) : topK;
  const perDoc = new Map<string, number>();
  const taken = new Set<number>();
  const candidates: Array<{ e: Ranked; t: TraceCandidate | null; rare: boolean }> = [];
  const queues = passes.map((p) => p.evaluated.filter((ev) => ev.ok));
  const overflow: Array<{ ev: Evaluated; via: string | null }> = [];
  while (queues.some((q) => q.length > 0)) {
    queues.forEach((q, i) => {
      const ev = q.shift();
      if (!ev || taken.has(ev.e.row.id)) return;
      taken.add(ev.e.row.id);
      const via = passes[i]!.info.label;
      if (candidates.length >= limit) {
        overflow.push({ ev, via });
      } else if ((perDoc.get(ev.e.row.doc_id) ?? 0) >= maxPerDoc) {
        addTrace(ev, via, "troppe sezioni dello stesso documento", false);
      } else {
        perDoc.set(ev.e.row.doc_id, (perDoc.get(ev.e.row.doc_id) ?? 0) + 1);
        candidates.push({ e: ev.e, t: addTrace(ev, via, ev.verdict, true), rare: ev.rare });
      }
    });
    if (candidates.length >= limit && overflow.length >= MAX_TRACE) break;
  }
  for (const { ev, via } of overflow) addTrace(ev, via, "oltre il limite", false);
  for (const p of passes) {
    for (const ev of p.evaluated) {
      if (!ev.ok && !taken.has(ev.e.row.id)) {
        taken.add(ev.e.row.id);
        addTrace(ev, p.info.label, ev.verdict, false);
      }
    }
  }

  const focusTerms = [...new Set(passes.flatMap((p) => p.terms))];
  let selected = candidates.slice(0, topK);
  if (rerank && candidates.length > 0) {
    try {
      const scores = await rerankPassages({
        query,
        conversationHint: opts.conversationHint,
        glossaryNote,
        followUpOf: opts.followUpOf,
        focusTerms,
        passages: candidates.map(({ e }) => ({ title: e.row.doc_title, heading: e.row.heading, content: e.row.content })),
      });
      candidates.forEach((c, i) => {
        if (c.t) c.t.rerankScore = scores[i] ?? 0;
      });
      const scored = candidates
        .map((c, i) => ({ c, s: scores[i] ?? 0, i }))
        .sort((a, b) => b.s - a.s || a.i - b.i);
      const threshold = rerankThreshold();
      const kept = scored.filter((x) => x.s >= threshold);
      // Safety nets, so a re-ranker misjudgement can't hide an answer that exists:
      // 1. passages containing a rare term of the question (an exact field or
      //    code name) are kept even when rated low;
      for (const x of scored.filter((y) => y.c.rare && y.s < threshold).slice(0, MAX_PROTECTED)) {
        kept.push(x);
        if (x.c.t) x.c.t.verdict = `${x.c.t.verdict} · tenuto: termine raro`;
      }
      // 2. if nothing passed, the few best with a non-zero score still go to the
      //    answer model, which is told to ignore what doesn't help.
      if (kept.length === 0) {
        for (const x of scored.filter((y) => y.s > 0).slice(0, RERANK_FALLBACK)) {
          kept.push(x);
          if (x.c.t) x.c.t.verdict = `${x.c.t.verdict} · tenuto: nessuno sopra soglia`;
        }
      }
      selected = kept
        .sort((a, b) => b.s - a.s || a.i - b.i)
        .slice(0, topK)
        .map((x) => x.c);
      trace.rerank = "ok";
    } catch (err) {
      // The re-ranker is an improvement, not a dependency: fall back to the hybrid order.
      trace.rerank = "failed";
      trace.rerankError = err instanceof Error ? err.message : String(err);
      logger.warn({ err }, "search_rerank_failed");
    }
  }

  for (const c of selected) if (c.t) c.t.selected = true;
  return { chunks: selected.map((c) => toChunk(c.e)), trace, glossaryNote };
}

/** Relevant chunks for a question, best first. Returns [] when nothing is relevant. */
export async function search(
  query: string,
  topK = config.SEARCH_TOP_K,
  scope?: SearchScope,
  opts: SearchOptions = {},
): Promise<RetrievedChunk[]> {
  return (await searchWithTrace(query, topK, scope, opts)).chunks;
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
  for (const e of (await rankHybrid(query, scope)).ranked) {
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
