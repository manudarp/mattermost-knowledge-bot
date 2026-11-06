import { z } from "zod";
import { callModelJson } from "../ai/jsonCall.js";
import { noThinkHint } from "../ai/client.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { HttpError } from "../utils/retry.js";

/**
 * LLM re-ranking. Search proposes ~20 candidate passages that *look* related
 * (similar wording or meaning); the model reads each one against the question
 * and scores whether it actually helps answer it. Only the passages it rates
 * useful reach the answer prompt, so a general question isn't answered with
 * details about a niche integration that merely shares its vocabulary.
 */

export interface RerankPassage {
  title: string;
  heading: string;
  content: string;
}

const PASSAGE_CHARS = 800;

/**
 * The part of a passage most worth showing the re-ranker: the window of
 * `size` characters containing the most distinct query terms. Chunks can be
 * ~1800 characters and the answer (a field in a table, a code name) is often
 * past the beginning, where a plain prefix would cut it off.
 */
export function focusWindow(text: string, terms: string[], size: number): string {
  if (text.length <= size) return text;
  const lower = text.toLowerCase();
  const hits: Array<{ pos: number; term: number }> = [];
  terms.forEach((t, ti) => {
    if (!t) return;
    for (let p = lower.indexOf(t); p >= 0 && hits.length < 500; p = lower.indexOf(t, p + t.length)) hits.push({ pos: p, term: ti });
  });
  if (hits.length === 0) return `${text.slice(0, size)}…`;

  let bestStart = 0;
  let bestScore = -1;
  for (const h of hits) {
    const start = Math.max(0, Math.min(h.pos - Math.floor(size / 4), text.length - size));
    const inside = hits.filter((x) => x.pos >= start && x.pos < start + size);
    const score = new Set(inside.map((x) => x.term)).size * 100 + inside.length;
    if (score > bestScore) {
      bestScore = score;
      bestStart = start;
    }
  }
  // Start at a word boundary.
  const ws = bestStart > 0 ? text.lastIndexOf(" ", bestStart) : 0;
  const start = ws > 0 && bestStart - ws < 40 ? ws + 1 : bestStart;
  const end = Math.min(text.length, start + size);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

const SYSTEM_PROMPT = `Valuti la pertinenza di passaggi di documentazione aziendale rispetto alla domanda di un utente.
Per ogni passaggio assegna un punteggio:
3 = risponde direttamente alla domanda
2 = contiene informazioni utili per rispondere
1 = solo marginale: argomento collegato, caso particolare, integrazione con un altro prodotto o scenario specifico che la domanda non menziona
0 = non pertinente

Valuta rispetto a ciò che la domanda chiede davvero. Se la domanda è generale, i passaggi su casi particolari,
integrazioni o configurazioni specifiche valgono al massimo 1, a meno che la domanda li citi.
Se la domanda riguarda uno o più prodotti specifici, i passaggi su prodotti che la domanda non nomina valgono 0.
Se la domanda contiene più richieste, un passaggio che risponde bene a una sola di esse vale comunque 3.
Rispondi SOLO con un oggetto JSON: {"scores":[{"id":<numero passaggio>,"score":<0-3>}, ...]} con tutti i passaggi.`;

const ScoresSchema = z.object({
  scores: z.array(z.object({ id: z.coerce.number().int(), score: z.coerce.number().min(0).max(3) })),
});

export interface RerankInput {
  query: string;
  passages: RerankPassage[];
  conversationHint?: string;
  glossaryNote?: string;
  /** Previous question in the thread, for short follow-ups. */
  followUpOf?: string;
  /** Query terms (lowercase): long passages are trimmed around them, not cut at the start. */
  focusTerms?: string[];
}

/** Minimum score a passage needs, on the scale of the configured re-ranker. */
export function rerankThreshold(): number {
  return config.SEARCH_RERANK_PROVIDER === "api" ? config.RERANK_MIN_SCORE : config.SEARCH_RERANK_MIN_SCORE;
}

/**
 * One relevance score per passage, in input order: 0–3 from the chat model
 * (`llm`), or 0–1 from a dedicated reranker model (`api`). Throws on failure.
 */
export async function rerankPassages(opts: RerankInput): Promise<number[]> {
  return config.SEARCH_RERANK_PROVIDER === "api" ? rerankWithApi(opts) : rerankWithLlm(opts);
}

/** {base}/rerank, unless the base already is the endpoint. */
export function rerankUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return base.endsWith("/rerank") ? base : `${base}/rerank`;
}


/**
 * Dedicated reranker (cross-encoder such as Qwen3-Reranker or bge-reranker):
 * it reads question + passage together and returns a relevance score. No text
 * is generated, so it is cheap and fast. Only the bare question is sent;
 * for follow-ups the previous question is prepended.
 */
async function rerankWithApi(opts: RerankInput): Promise<number[]> {
  if (!config.RERANK_BASE_URL) throw new Error("RERANK_BASE_URL is required when SEARCH_RERANK_PROVIDER=api");
  const url = rerankUrl(config.RERANK_BASE_URL);
  const apiKey = config.RERANK_API_KEY || config.LLM_API_KEY;
  const headers: Record<string, string> = { "Content-Type": "application/json", ...config.LLM_EXTRA_HEADERS };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const question = opts.followUpOf ? `${opts.followUpOf} — ${opts.query}` : opts.query;
  const query = opts.glossaryNote ? `${question} (${opts.glossaryNote})` : question;
  const documents = opts.passages.map((p) => {
    const text = `${p.title}${p.heading && p.heading !== p.title ? ` › ${p.heading}` : ""}
${p.content}`;
    return focusWindow(text, opts.focusTerms ?? [], config.RERANK_MAX_CHARS);
  });
  const body =
    config.RERANK_API_FORMAT === "tei"
      ? { query, texts: documents, raw_scores: false }
      : {
          ...(config.RERANK_MODEL ? { model: config.RERANK_MODEL } : {}),
          query,
          documents,
          top_n: documents.length,
          ...(config.RERANK_PROVIDER_PREFS ? { provider: config.RERANK_PROVIDER_PREFS } : {}),
        };

  const t0 = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.RERANK_TIMEOUT_MS),
  });
  const raw = await res.text();
  if (!res.ok) throw new HttpError(res.status, raw.slice(0, 500), `HTTP ${res.status} POST ${url}: ${raw.slice(0, 200)}`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`reranker returned non-JSON: ${raw.slice(0, 200)}`);
  }
  const scores = parseRerankResponse(parsed, documents.length);
  const usage = (parsed as { usage?: Record<string, unknown> }).usage;
  logger.info({ model: config.RERANK_MODEL || null, passages: documents.length, ms: Date.now() - t0, usage: usage ?? null }, "rerank_api_call");
  return scores;
}

/**
 * Accepts the common response shapes:
 *  {results:[{index, relevance_score}]} (Cohere/Jina/OpenRouter/llama.cpp),
 *  {data:[…]}, and [{index, score}] (TEI).
 */
export function parseRerankResponse(parsed: unknown, count: number): number[] {
  const obj = parsed as { results?: unknown; data?: unknown };
  const list = Array.isArray(parsed) ? parsed : Array.isArray(obj?.results) ? obj.results : Array.isArray(obj?.data) ? obj.data : null;
  if (!list) throw new Error("reranker response has no results");
  const scores = new Array<number>(count).fill(0);
  let seen = 0;
  for (const item of list as Array<Record<string, unknown>>) {
    const index = Number(item.index);
    const score = Number(item.relevance_score ?? item.score);
    if (!Number.isInteger(index) || index < 0 || index >= count || !Number.isFinite(score)) continue;
    scores[index] = score;
    seen++;
  }
  if (seen === 0) throw new Error("reranker response contains no valid scores");
  return scores;
}

async function rerankWithLlm(opts: RerankInput): Promise<number[]> {
  const { query, passages } = opts;
  const list = passages
    .map((p, i) => {
      const body = focusWindow(p.content, opts.focusTerms ?? [], PASSAGE_CHARS);
      return `[${i + 1}] ${p.title}${p.heading && p.heading !== p.title ? ` › ${p.heading}` : ""}\n${body}`;
    })
    .join("\n\n");

  const hint = noThinkHint();
  const userPrompt =
    (hint ? `${hint}\n\n` : "") +
    (opts.conversationHint ? `Contesto della conversazione (per capire la domanda):\n${opts.conversationHint}\n\n` : "") +
    (opts.glossaryNote ? `Sigle e sinonimi: ${opts.glossaryNote}\n\n` : "") +
    `Domanda: ${query}\n\nPassaggi:\n${list}`;

  const result = await callModelJson({
    name: "rerank",
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    schema: ScoresSchema,
    maxTokens: 1500,
    temperature: 0,
    attempts: 2,
    validate: (v) => {
      const bad = v.scores.find((s) => s.id < 1 || s.id > passages.length);
      return bad ? `"id" must be between 1 and ${passages.length} (got ${bad.id})` : null;
    },
  });

  const scores = passages.map(() => 0);
  for (const s of result.scores) scores[s.id - 1] = s.score;
  return scores;
}
