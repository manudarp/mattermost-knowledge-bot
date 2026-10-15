import { config } from "../config.js";
import { retryWithBackoff, HttpError, isNetworkError } from "../utils/retry.js";
import { Semaphore } from "../utils/semaphore.js";

// Default is one LLM call at a time — llama.cpp is single-slot by default and
// queuing at this layer gives callers a clean "waiting in queue" signal.
// Remote providers (OpenRouter etc.) can raise LLM_MAX_CONCURRENCY.
const llmSemaphore = new Semaphore(config.LLM_MAX_CONCURRENCY);

export interface CallModelResult {
  text: string;
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

async function callOpenAICompatible(opts: CallModelOpts): Promise<CallModelResult> {
  const body = {
    model: config.LLM_MODEL,
    messages: [
      { role: "system", content: opts.systemPrompt },
      { role: "user", content: opts.userPrompt },
    ],
    max_tokens: opts.maxTokens,
    temperature: opts.temperature,
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
        choices?: Array<{ message?: { content?: string | null } }>;
        usage?: { prompt_tokens: number; completion_tokens: number };
        error?: { message?: string };
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

  const rawText = data.choices?.[0]?.message?.content ?? "";
  const text = stripThinkTags(rawText);
  return {
    text,
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
