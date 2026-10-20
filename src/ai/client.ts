import { config } from "../config.js";
import { retryWithBackoff, HttpError, isNetworkError } from "../utils/retry.js";
import { logger } from "../logger.js";
import { Semaphore } from "../utils/semaphore.js";

// Default is one LLM call at a time — llama.cpp is single-slot by default and
// queuing at this layer gives callers a clean "waiting in queue" signal.
// Remote providers (OpenRouter etc.) can raise LLM_MAX_CONCURRENCY.
const llmSemaphore = new Semaphore(config.LLM_MAX_CONCURRENCY);

export interface CallModelResult {
  text: string;
  /** Provider's stop reason ("stop", "length", "max_tokens"…), when reported. */
  finishReason: string | null;
  /** Generation stopped because it hit the output-token limit. */
  truncated: boolean;
  /** The model produced a reasoning/thinking trace (which also consumes output tokens). */
  reasoned: boolean;
  usage: { input: number; output: number };
}

export interface CallModelOpts {
  systemPrompt: string;
  userPrompt: string;
  maxTokens: number;
  temperature: number;
}

/**
 * Strip <think>…</think> blocks from reasoning-model output (Qwen 3.x, DeepSeek-R1,
 * etc.). The chain-of-thought is interesting but never the final answer; if it
 * leaks into our `text` field the rendered Outline page gets garbage.
 *
 * Takes everything after the last </think>. If the response is `<think>…` with
 * no closing tag (CoT truncated by max_tokens), returns "" so the retry path
 * can re-ask.
 */
function stripThinkTags(text: string): string {
  const closeIdx = text.lastIndexOf("</think>");
  if (closeIdx !== -1) {
    return text.slice(closeIdx + "</think>".length).trim();
  }
  if (text.trimStart().startsWith("<think>")) return "";
  return text;
}

/**
 * Build the chat-completions URL. Local servers are usually configured as
 * "http://host:8020" while hosted providers document the base including the
 * version ("https://openrouter.ai/api/v1") — accept both.
 */
export function chatCompletionsUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  if (base.endsWith("/chat/completions")) return base;
  if (/\/v\d+$/.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

/** Qwen 3.x's switch to skip the reasoning phase; empty when disabled. */
export function noThinkHint(): string {
  return config.LLM_NO_THINK_HINT ? "/no_think" : "";
}

type MessageContent = string | null | Array<{ type?: string; text?: string }>;

/** Some providers return content as an array of parts instead of a string. */
function contentToText(content: MessageContent | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content.map((p) => (typeof p?.text === "string" ? p.text : "")).join("");
}

async function callOpenAICompatible(opts: CallModelOpts): Promise<CallModelResult> {
  const body = {
    model: config.LLM_MODEL,
    messages: [
      { role: "system", content: opts.systemPrompt },
      { role: "user", content: opts.userPrompt },
    ],
    max_tokens: opts.maxTokens,
    temperature: opts.temperature,
    // OpenRouter's unified reasoning control; only sent when configured because
    // other OpenAI-compatible servers may reject unknown parameters.
    ...(config.LLM_REASONING_EFFORT ? { reasoning: { effort: config.LLM_REASONING_EFFORT } } : {}),
    ...(config.LLM_PROVIDER_PREFS ? { provider: config.LLM_PROVIDER_PREFS } : {}),
    ...(config.LLM_FALLBACK_MODELS.length > 0 ? { models: config.LLM_FALLBACK_MODELS } : {}),
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...config.LLM_EXTRA_HEADERS,
  };
  if (config.LLM_API_KEY) headers["Authorization"] = `Bearer ${config.LLM_API_KEY}`;

  const url = chatCompletionsUrl(config.LLM_BASE_URL ?? "");

  // The self-hosted LLM occasionally drops the socket mid-generation
  // ("fetch failed: other side closed"); hosted providers return 429/5xx under
  // load. Retry both with backoff, but never auth/validation errors.
  const data = await retryWithBackoff(
    async () => {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.LLM_TIMEOUT_MS),
      });

      if (!res.ok) {
        const err = await res.text().catch(() => "");
        throw new HttpError(res.status, err, `LLM request failed: ${res.status} ${err.slice(0, 300)}`);
      }

      return (await res.json()) as {
        choices?: Array<{
          message?: { content?: MessageContent; reasoning?: string | null; reasoning_content?: string | null };
          finish_reason?: string | null;
        }>;
        usage?: { prompt_tokens: number; completion_tokens: number };
        error?: { message?: string };
        /** Model / upstream provider that actually served the request (OpenRouter). */
        model?: string;
        provider?: string;
      };
    },
    {
      shouldRetry: (err) => {
        if (err instanceof HttpError) return err.status === 429 || err.status >= 500;
        if (err instanceof Error && err.name === "TimeoutError") return false;
        return isNetworkError(err) || (err instanceof Error && /other side closed|socket/i.test(err.message));
      },
    },
  );

  // OpenRouter can return HTTP 200 with an `error` object (upstream failure).
  if (data.error) throw new Error(`LLM provider error: ${data.error.message ?? "unknown"}`);

  // With routers, presets and fallbacks the requested model isn't necessarily
  // the one that answered: log it, so data-residency choices can be audited.
  logger.info(
    {
      requested_model: config.LLM_MODEL,
      model: data.model ?? null,
      provider: data.provider ?? null,
      tokens_in: data.usage?.prompt_tokens ?? 0,
      tokens_out: data.usage?.completion_tokens ?? 0,
      finish_reason: data.choices?.[0]?.finish_reason ?? null,
    },
    "llm_call",
  );

  const choice = data.choices?.[0];
  const rawText = contentToText(choice?.message?.content);
  const text = stripThinkTags(rawText);
  const finishReason = choice?.finish_reason ?? null;
  const reasoned = Boolean(
    choice?.message?.reasoning || choice?.message?.reasoning_content || rawText.trimStart().startsWith("<think>"),
  );
  return {
    text,
    finishReason,
    truncated: finishReason === "length" || finishReason === "max_tokens",
    reasoned,
    usage: {
      input: data.usage?.prompt_tokens ?? 0,
      output: data.usage?.completion_tokens ?? 0,
    },
  };
}

async function callAnthropic(opts: CallModelOpts): Promise<CallModelResult> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

  const response = await client.messages.create({
    model: config.ANTHROPIC_MODEL,
    max_tokens: opts.maxTokens,
    temperature: opts.temperature,
    system: opts.systemPrompt,
    messages: [{ role: "user", content: opts.userPrompt }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text content in Claude response");
  }

  return {
    text: textBlock.text,
    finishReason: response.stop_reason ?? null,
    truncated: response.stop_reason === "max_tokens",
    reasoned: false,
    usage: {
      input: response.usage.input_tokens,
      output: response.usage.output_tokens,
    },
  };
}

export async function callModel(opts: CallModelOpts): Promise<CallModelResult> {
  return llmSemaphore.run(() =>
    config.LLM_BASE_URL ? callOpenAICompatible(opts) : callAnthropic(opts)
  );
}

export function llmQueueDepth(): { running: number; pending: number } {
  return { running: llmSemaphore.running, pending: llmSemaphore.pending };
}

export function llmDescription(): string {
  if (!config.LLM_BASE_URL) return `anthropic:${config.ANTHROPIC_MODEL}`;
  return `${new URL(config.LLM_BASE_URL).host}:${config.LLM_MODEL}`;
}
