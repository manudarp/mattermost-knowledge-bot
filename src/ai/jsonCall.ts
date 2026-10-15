import type { z } from "zod";
import { logger } from "../logger.js";
import { callModel } from "./client.js";
import { config } from "../config.js";
import { stripJsonFences } from "./jsonExtract.js";

export interface JsonCallOpts<T> {
  /** Used in log event names, e.g. "placement" → ai_placement_completed */
  name: string;
  systemPrompt: string;
  userPrompt: string;
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  maxTokens: number;
  temperature: number;
  /** Extra semantic validation (e.g. "target id must exist"). Return an error
   * string to trigger the retry with that feedback, or null when valid. */
  validate?: (value: T) => string | null | Promise<string | null>;
  attempts?: number;
}

async function tryParse<T>(
  text: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  validate?: (value: T) => string | null | Promise<string | null>,
): Promise<T | { error: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFences(text));
  } catch (err) {
    return { error: `JSON parse failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    return { error: `Schema validation failed: ${result.error.message}` };
  }
  if (validate) {
    const semantic = await validate(result.data);
    if (semantic) return { error: semantic };
  }
  return result.data;
}

function isError<T>(v: T | { error: string }): v is { error: string } {
  return typeof v === "object" && v !== null && "error" in v && Object.keys(v).length === 1;
}

/**
 * Calls the model expecting a single JSON object. On parse/schema/semantic
 * failure the model is re-asked with the error and its previous answer.
 */
export async function callModelJson<T>(opts: JsonCallOpts<T>): Promise<T> {
  const attempts = opts.attempts ?? 3;
  let prompt = opts.userPrompt;
  let maxTokens = opts.maxTokens;
  let tokensIn = 0;
  let tokensOut = 0;
  let lastError = "";

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const res = await callModel({
      systemPrompt: opts.systemPrompt,
      userPrompt: prompt,
      maxTokens,
      temperature: opts.temperature,
    });
    tokensIn += res.usage.input;
    tokensOut += res.usage.output;
    const meta = {
      attempt,
      max_tokens: maxTokens,
      finish_reason: res.finishReason,
      tokens_out: res.usage.output,
      reasoning: res.reasoned,
    };

    // Empty or cut-off output: re-asking with the same budget would fail the
    // same way (typically a reasoning model spending the budget on thinking).
    // Retry the ORIGINAL prompt with a larger budget instead.
    if (!res.text.trim() || res.truncated) {
      lastError = res.text.trim()
        ? `risposta troncata dal limite di token (finish_reason=${res.finishReason}, ${res.usage.output} token)`
        : `il modello ha restituito una risposta vuota (finish_reason=${res.finishReason ?? "n/d"}, ${res.usage.output} token di output${res.reasoned ? ", spesi nel ragionamento" : ""})`;
      logger.warn({ ...meta, response: res.text.slice(0, 300) }, `ai_${opts.name}_empty_or_truncated`);
      maxTokens = Math.min(maxTokens * 2, config.LLM_MAX_OUTPUT_TOKENS);
      prompt = res.truncated
        ? `${opts.userPrompt}\n\nYour previous answer was cut off by the length limit. Be more concise and return ONLY the JSON object.`
        : opts.userPrompt;
      continue;
    }

    const parsed = await tryParse(res.text, opts.schema, opts.validate);
    if (!isError(parsed)) {
      logger.info({ tokens_in: tokensIn, tokens_out: tokensOut, attempts: attempt }, `ai_${opts.name}_completed`);
      return parsed;
    }

    lastError = parsed.error;
    logger.warn({ ...meta, err: lastError, response: res.text.slice(0, 500) }, `ai_${opts.name}_invalid`);
    prompt = `${opts.userPrompt}

Your previous response was invalid: ${lastError}
Please retry, returning ONLY the corrected JSON object. Previous response:
${res.text.slice(0, 6000)}`;
  }

  throw new Error(`AI ${opts.name}: ${lastError} (dopo ${attempts} tentativi)`);
}
