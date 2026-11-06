import { z } from "zod";

// Local development: load ./.env with Node's built-in parser (no dotenv
// dependency). Variables already set in the environment win, so in Docker
// (env_file / environment) this is a no-op; a missing file is fine.
try {
  process.loadEnvFile();
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
}

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

  // --- Embeddings ---------------------------------------------------------
  //  ollama → local Ollama server (OLLAMA_URL)
  //  openai → any OpenAI-compatible /embeddings endpoint (OpenRouter, Mistral, …)
  EMBEDDING_PROVIDER: z.enum(["ollama", "openai"]).default("ollama"),
  EMBEDDING_MODEL: z.string().default("bge-m3"),
  EMBEDDING_BASE_URL: z.string().url().optional().or(z.literal("")),
  // Falls back to LLM_API_KEY when empty (same OpenRouter account).
  EMBEDDING_API_KEY: z.string().default(""),
  // OpenRouter only: provider routing for embedding requests, e.g. {"zdr":true}
  EMBEDDING_PROVIDER_PREFS: z
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
  // Texts per embedding request. Small for a slow local CPU, larger for hosted APIs.
  EMBEDDING_BATCH_SIZE: z.coerce.number().int().positive().max(256).default(8),
  EMBEDDING_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  // Text prepended to search queries (not to documents) before embedding. Some
  // models are trained with an instruction, e.g. Qwen3-Embedding:
  // "Instruct: Given a question, retrieve passages that answer it\nQuery: "
  // Use "\n" for a newline.
  EMBEDDING_QUERY_PREFIX: z
    .string()
    .default("")
    .transform((s) => s.replace(/\\n/g, "\n")),

  OLLAMA_URL: z.string().url().default("http://ollama:11434"),
  INDEX_SYNC_INTERVAL_MINUTES: z.coerce.number().int().positive().default(60),
  // Pause between full-document downloads during a sync, to stay under Outline's rate limiter.
  OUTLINE_REQUEST_DELAY_MS: z.coerce.number().int().min(0).max(60_000).default(300),

  // --- Chunking & retrieval ---------------------------------------------------
  // Target size of an indexed chunk; sections longer than this are split.
  CHUNK_MAX_CHARS: z.coerce.number().int().min(300).max(20_000).default(1800),
  // Text repeated at the start of the next chunk when a section is split.
  CHUNK_OVERLAP_CHARS: z.coerce.number().int().min(0).max(2000).default(200),
  // Chunks passed to the LLM per answer, and max chunks from a single document.
  SEARCH_TOP_K: z.coerce.number().int().positive().max(30).default(8),
  SEARCH_MAX_CHUNKS_PER_DOC: z.coerce.number().int().positive().max(30).default(4),
  // Semantic matches scoring more than this below the best one are dropped,
  // whatever SEARCH_SCORE_THRESHOLD says (embedding scores are compressed:
  // with bge-m3 even unrelated text often scores 0.35–0.45).
  SEARCH_RELATIVE_MARGIN: z.coerce.number().min(0).max(1).default(0.15),
  // A keyword-only match must contain this share of the query's distinctive
  // terms (weighted by rarity), so one generic word like "documenti" isn't enough.
  SEARCH_KEYWORD_MIN_COVERAGE: z.coerce.number().min(0).max(1).default(0.4),
  // Acronyms / synonyms used to widen searches, e.g.
  // "AHRW=Ad hoc Revolution Web; G1=Gestionale 1|Gestionale uno". More can be added from chat (`glossario`).
  SEARCH_GLOSSARY: z.string().default(""),
  // The LLM picks, among the best candidates, the passages that really answer
  // the question (one extra short call per question).
  SEARCH_RERANK: boolFlag(true),
  // Before searching, the LLM splits multi-part questions into 2–3 self-contained
  // queries (searched separately) and completes short follow-ups from the thread.
  // Only called when the question looks multi-part or is a follow-up.
  SEARCH_DECOMPOSE: boolFlag(true),
  // Passages sent to the re-ranker. A local reranker on CPU costs roughly
  // RERANK_MAX_CHARS/1500 × 1–4 s per passage: keep this low on slow machines.
  SEARCH_RERANK_CANDIDATES: z.coerce.number().int().min(2).max(60).default(20),
  // 3 = answers the question, 2 = useful, 1 = marginal / special case, 0 = unrelated.
  SEARCH_RERANK_MIN_SCORE: z.coerce.number().int().min(1).max(3).default(2),
  //  llm → the chat model (LLM_*) rates the passages
  //  api → a dedicated reranker model via a /rerank endpoint (OpenRouter, llama.cpp, TEI…)
  SEARCH_RERANK_PROVIDER: z.enum(["llm", "api"]).default("llm"),
  // e.g. https://openrouter.ai/api/v1 · http://reranker:8080/v1 (llama.cpp) · http://reranker:80 (TEI)
  RERANK_BASE_URL: z.string().url().optional().or(z.literal("")),
  RERANK_MODEL: z.string().default(""),
  // Falls back to LLM_API_KEY when empty. Local servers ignore it.
  RERANK_API_KEY: z.string().default(""),
  //  cohere → {model, query, documents, top_n} → {results:[{index, relevance_score}]} (OpenRouter, llama.cpp, Jina, Cohere)
  //  tei    → {query, texts} → [{index, score}] (Hugging Face text-embeddings-inference)
  RERANK_API_FORMAT: z.enum(["cohere", "tei"]).default("cohere"),
  // OpenRouter only: provider routing for rerank requests, e.g. {"zdr":true,"data_collection":"deny"}
  RERANK_PROVIDER_PREFS: z
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
  // Reranker relevance (0–1) a passage needs to reach the answer. Tune it with `@bot debug`.
  RERANK_MIN_SCORE: z.coerce.number().min(0).max(1).default(0.3),
  RERANK_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  // Characters of each passage sent to a reranker model. The cost of a
  // cross-encoder grows with the text: shorter is much faster on CPU.
  RERANK_MAX_CHARS: z.coerce.number().int().min(200).max(8000).default(1500),

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
  SEARCH_SCORE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.4),

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
