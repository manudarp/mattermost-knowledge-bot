import "dotenv/config";
import { z } from "zod";

const csvList = (lower: boolean) =>
  z
    .string()
    .default("")
    .transform((s) =>
      s
        .split(",")
        .map((t) => (lower ? t.trim().toLowerCase() : t.trim()))
        .filter(Boolean),
    );

const boolFlag = (def: boolean) =>
  z.preprocess(
    (v) => (typeof v === "string" ? v.trim().toLowerCase() : v),
    z
      .enum(["true", "false", "1", "0", "yes", "no", ""])
      .default(def ? "true" : "false")
      .transform((v) => (v === "" ? def : v === "true" || v === "1" || v === "yes")),
  );

const ConfigSchema = z.object({
  MM_URL: z.string().url(),
  MM_BOT_TOKEN: z.string().min(20),
  MM_BOT_USERNAME: z.string().min(1),
  MM_BOT_USER_ID: z.string().optional().default(""),

  OUTLINE_URL: z.string().url(),
  OUTLINE_API_TOKEN: z.string().min(20),

  ANTHROPIC_API_KEY: z.string().default(""),
  ANTHROPIC_MODEL: z.string().default("claude-haiku-4-5-20251001"),

  // When set, use this OpenAI-compatible endpoint instead of Anthropic.
  // Accepts both "http://host:8020" and "https://openrouter.ai/api/v1".
  LLM_BASE_URL: z.string().url().optional().or(z.literal("")),
  LLM_MODEL: z.string().default("Qwen3.6-27B-UD-Q4_K_XL.gguf"),
  // Bearer token for the OpenAI-compatible endpoint (OpenRouter, OpenAI, Groq…).
  LLM_API_KEY: z.string().default(""),
  // Extra HTTP headers as JSON, e.g. {"HTTP-Referer":"https://wiki.example.com","X-Title":"KB Bot"}
  LLM_EXTRA_HEADERS: z
    .string()
    .default("")
    .transform((s, ctx) => {
      if (!s.trim()) return {} as Record<string, string>;
      try {
        const parsed: unknown = JSON.parse(s);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return Object.fromEntries(
            Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
          );
        }
      } catch {
        /* fall through */
      }
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be a JSON object of header → value" });
      return z.NEVER;
    }),
  // OpenRouter only: provider routing constraints sent with EVERY request, e.g.
  // {"zdr":true,"data_collection":"deny","allow_fallbacks":false}. They add to
  // (never relax) the account privacy settings and the key's guardrail.
  LLM_PROVIDER_PREFS: z
    .string()
    .default("")
    .transform((s, ctx) => {
      if (!s.trim()) return null;
      try {
        const parsed: unknown = JSON.parse(s);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
      } catch {
        /* fall through */
      }
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be a JSON object (OpenRouter `provider` preferences)" });
      return z.NEVER;
    }),
  // OpenRouter only: ordered fallback models tried if LLM_MODEL fails (sent as `models`).
  LLM_FALLBACK_MODELS: csvList(false),
  // Parallel LLM calls. Keep 1 for single-slot llama.cpp; raise for remote providers.
  LLM_MAX_CONCURRENCY: z.coerce.number().int().positive().default(1),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  // Ceiling for the automatic max_tokens escalation when a reply is cut off
  // (reasoning models spend part of the budget "thinking").
  LLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(16_000),
  // OpenRouter only: reasoning effort for thinking models (sent as `reasoning.effort`).
  LLM_REASONING_EFFORT: z.enum(["", "low", "medium", "high"]).default(""),
  // Append Qwen's `/no_think` switch to prompts. Harmless elsewhere, but can be disabled.
  LLM_NO_THINK_HINT: boolFlag(true),

  OLLAMA_URL: z.string().url().default("http://ollama:11434"),
  INDEX_SYNC_INTERVAL_MINUTES: z.coerce.number().int().positive().default(60),

  BOT_TRIGGER_MENTIONS: z
    .string()
    .default("wikibot,kb,knowledge-bot")
    .transform((s) =>
      s
        .split(",")
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
    ),
  // Usernames allowed to change bot-wide (global) collections. Empty = everyone.
  BOT_ADMINS: csvList(true),

  // Collections (names, URLs or IDs) always readable/writable from every channel.
  // Pinned here; additional ones can be linked at runtime via `@bot collezioni aggiungi`.
  OUTLINE_COLLECTIONS: csvList(false),
  // Legacy behaviour: create a dedicated Outline collection when the bot joins a channel.
  AUTO_CREATE_CHANNEL_COLLECTION: boolFlag(false),

  // Free-text questions not grounded in the KB are answered by the LLM directly.
  GENERAL_QA_ENABLED: boolFlag(true),
  SEARCH_SCORE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.3),

  // Save flow (human-in-the-loop)
  //  always            → every change must be approved in Mattermost
  //  auto_high_conf    → non-destructive changes above the threshold are applied directly
  SAVE_APPROVAL_MODE: z.enum(["always", "auto_high_conf"]).default("always"),
  // Usernames who may approve anyone's proposals (the requester can always approve their own).
  SAVE_APPROVERS: csvList(true),
  // Heading of the audit section appended to every touched document. Empty disables it.
  SAVE_CHANGELOG_HEADING: z.string().default("Storico aggiornamenti"),

  CONFIRMATION_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.85),
  CONFIRMATION_TTL_MINUTES: z.coerce.number().int().positive().default(60),
  CLEANUP_INTERVAL_MINUTES: z.coerce.number().int().positive().default(5),

  DB_PATH: z.string().default("./data/kb-bot.db"),

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("production"),

  API_PORT: z.coerce.number().int().positive().default(3333),
  API_CORS_ORIGIN: z.string().default("*"),
});

export type Config = z.infer<typeof ConfigSchema>;

function loadConfig(): Config {
  const parsed = ConfigSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    console.error(`Invalid environment configuration:\n${issues}`);
    process.exit(1);
  }
  return parsed.data;
}

export const config = loadConfig();
