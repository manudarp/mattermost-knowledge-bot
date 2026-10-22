import { config } from "../config.js";
import { logger } from "../logger.js";
import { retryWithBackoff, HttpError, isNetworkError } from "../utils/retry.js";

/**
 * Identifies the vector space. Vectors from different models (or providers
 * serving different weights) are not comparable: when this changes the whole
 * index is rebuilt (see ensureIndexMatchesEmbeddingModel).
 */
export function embeddingModelId(): string {
  return `${config.EMBEDDING_PROVIDER}:${config.EMBEDDING_MODEL}`;
}

function shouldRetry(err: unknown): boolean {
  if (err instanceof HttpError) return err.status === 429 || err.status >= 500;
  if (err instanceof Error && err.name === "TimeoutError") return true;
  return isNetworkError(err) || (err instanceof Error && /other side closed|socket/i.test(err.message));
}

async function embedOllama(texts: string[]): Promise<number[][]> {
  return retryWithBackoff(
    async () => {
      const res = await fetch(`${config.OLLAMA_URL}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: config.EMBEDDING_MODEL, input: texts, truncate: true }),
        signal: AbortSignal.timeout(config.EMBEDDING_TIMEOUT_MS),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new HttpError(res.status, body, `Ollama embed failed: ${res.status} ${body.slice(0, 300)}`);
      }
      const data = (await res.json()) as { embeddings?: number[][] };
      if (!Array.isArray(data.embeddings) || data.embeddings.length !== texts.length) {
        throw new Error(`Unexpected Ollama embed response: ${JSON.stringify(data).slice(0, 300)}`);
      }
      return data.embeddings;
    },
    { shouldRetry, retries: 2 },
  );
}

/** {base}/embeddings, accepting bases with or without the /v1 suffix. */
export function embeddingsUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  if (base.endsWith("/embeddings")) return base;
  if (/\/v\d+$/.test(base)) return `${base}/embeddings`;
  return `${base}/v1/embeddings`;
}

async function embedOpenAICompatible(texts: string[]): Promise<number[][]> {
  const baseUrl = config.EMBEDDING_BASE_URL || config.LLM_BASE_URL;
  if (!baseUrl) throw new Error("EMBEDDING_BASE_URL is required when EMBEDDING_PROVIDER=openai");
  const apiKey = config.EMBEDDING_API_KEY || config.LLM_API_KEY;

  const headers: Record<string, string> = { "Content-Type": "application/json", ...config.LLM_EXTRA_HEADERS };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const body = {
    model: config.EMBEDDING_MODEL,
    input: texts,
    ...(config.EMBEDDING_PROVIDER_PREFS ? { provider: config.EMBEDDING_PROVIDER_PREFS } : {}),
  };

  const data = await retryWithBackoff(
    async () => {
      const res = await fetch(embeddingsUrl(baseUrl), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.EMBEDDING_TIMEOUT_MS),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new HttpError(res.status, text, `Embedding request failed: ${res.status} ${text.slice(0, 300)}`);
      }
      return (await res.json()) as {
        data?: Array<{ embedding: number[]; index?: number }>;
        model?: string;
        provider?: string;
        usage?: { prompt_tokens?: number };
        error?: { message?: string };
      };
    },
    { shouldRetry },
  );

  if (data.error) throw new Error(`Embedding provider error: ${data.error.message ?? "unknown"}`);
  if (!Array.isArray(data.data) || data.data.length !== texts.length) {
    throw new Error(`Unexpected embedding response (${data.data?.length ?? 0} vectors for ${texts.length} inputs)`);
  }
  logger.debug(
    { model: data.model ?? null, provider: data.provider ?? null, inputs: texts.length, tokens: data.usage?.prompt_tokens ?? null },
    "embedding_call",
  );
  return [...data.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => d.embedding);
}

export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  return config.EMBEDDING_PROVIDER === "openai" ? embedOpenAICompatible(texts) : embedOllama(texts);
}

export async function embedOne(text: string): Promise<number[]> {
  const vecs = await embed([text]);
  if (!vecs[0]) throw new Error("embedding provider returned an empty vector");
  return vecs[0];
}

export async function ensureModelReady(): Promise<void> {
  if (config.EMBEDDING_PROVIDER === "openai") {
    const t0 = Date.now();
    const vec = await embedOne("ping");
    logger.info({ model: embeddingModelId(), dimensions: vec.length, ms: Date.now() - t0 }, "embedding_model_ready");
    return;
  }

  const model = config.EMBEDDING_MODEL;
  const url = `${config.OLLAMA_URL}/api/tags`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await res.json() as { models?: Array<{ name: string }> };
    const names = (data.models ?? []).map((m) => m.name);
    if (names.some((n) => n.startsWith(model))) {
      logger.info({ model }, "embedding_model_ready");
      return;
    }
  } catch (err) {
    logger.warn({ err }, "ollama_tags_check_failed");
  }

  logger.info({ model }, "pulling_embedding_model");
  const pullRes = await fetch(`${config.OLLAMA_URL}/api/pull`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, stream: false }),
  });
  if (!pullRes.ok) {
    const body = await pullRes.text().catch(() => "");
    throw new Error(`Failed to pull embedding model ${model}: ${pullRes.status} ${body}`);
  }
  logger.info({ model }, "embedding_model_pulled");
}
