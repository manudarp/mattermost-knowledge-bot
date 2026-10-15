# Mattermost Knowledge Bot

A self-hosted AI knowledge assistant that connects Mattermost and an Outline wiki. It answers questions from the wiki (or from general AI knowledge), and turns thread discussions into wiki content — finding the right collection and document to update, and **only writing after a human approves the proposed change**. A floating chat widget also lets you query the wiki directly from Outline pages.

Inference can run fully locally (embeddings via Ollama `bge-m3`, answers via llama.cpp/vLLM) or use a hosted OpenAI-compatible provider such as OpenRouter, or Anthropic.

## Features

- **Multiple collections, managed from chat** — link any set of Outline collections to a channel (or bot-wide) with `@wikibot collezioni aggiungi …`; questions read from all of them, saves write into the most fitting one. Collections can also be pinned in `.env`.
- **Questions: KB, general or both** — `@wikibot <question>` answers from the wiki when relevant documents exist, otherwise as a general assistant (clearly labelled). `cerca` forces wiki-only answers, `chiedi` forces a general answer. Follow-ups in a thread keep the conversation context.
- **Smart saving with human-in-the-loop** — `@wikibot salva [hint]` in a thread: the bot looks at the collections' document trees and at semantically similar documents, decides whether to **update an existing document** (with section-level edits) or **create a new one** in the right collection/parent, and posts a preview. Nothing is written until the requester (or a configured approver) confirms. The proposal can be redirected (`doc:`, `collezione:`, `sotto:`), renamed (`titolo:`) or regenerated with instructions (`nota:`).
- **Safe edits** — existing documents are never rewritten wholesale: the LLM proposes operations on named sections (`append_to_section`, `replace_section`, `add_section`) that are applied deterministically, so untouched content is preserved byte-for-byte and edits can be re-applied if someone changed the document meanwhile. Every touched document gets an audit line (who, when, what, link to the thread).
- **Any OpenAI-compatible LLM** — llama.cpp, vLLM, OpenRouter, OpenAI, Groq… with API key, extra headers and configurable concurrency; or Anthropic.
- **Outline chat widget** — a floating chat bubble embedded in Outline pages, scoped to the current document or collection.

## Architecture

```
Mattermost  ──WS──▶  bot  ──REST──▶  Outline
                      │
                      ├──REST──▶  Ollama (bge-m3 embeddings)
                      │
                      ├──REST──▶  LLM (OpenAI-compatible: local or OpenRouter… / Anthropic)
                      │
                      └──HTTP:3333──▶  Widget API  ◀──  Outline browser widget

Storage: SQLite  ./data/kb-bot.db
  ├── channels / channel_collections  (which Outline collections each channel may use; '*' = all channels)
  ├── save_proposals                  (pending/applied/cancelled KB changes, with their preview)
  ├── saves                           (audit of applied changes)
  ├── document_chunks + index_state   (chunked wiki content + embeddings)
  └── topics / pending_confirmations  (legacy, no longer used)
```

A background job re-indexes all Outline documents the token can see every `INDEX_SYNC_INTERVAL_MINUTES` (and drops deleted ones); search is then filtered to the collections linked to the channel.

### How a save works

1. `@wikibot salva aggiorna la fase 2 del progetto ACME` in a thread.
2. The bot reads the thread (+ text of attached PDF/DOCX/text files), the document trees of the channel's collections and the most similar documents (semantic search).
3. **Placement** (LLM): update document X, or create "ACME — Fase 2" in collection Y under parent Z.
4. **Drafting** (LLM): section-level edits for an existing document (dry-run validated against the real document), or the body of the new document.
5. The bot posts a **proposal** with the target path, confidence, reasoning and a preview of every change.
6. 👍/✅ or `ok` → the change is applied (attachments uploaded, audit line added, document re-indexed). 👎/❌ or `annulla` → discarded. Unanswered proposals expire after `CONFIRMATION_TTL_MINUTES`.

The bot only ever writes into collections linked to the channel, and re-checks this at approval time.

## Prerequisites

- Mattermost bot account (System Console → Integrations → Bot Accounts). The bot must be a member of the team(s) it serves.
- Outline instance with an API token (Settings → API tokens). The token's user needs read/write access to the collections you want the bot to use (and permission to create collections if you use `collezioni crea` or `AUTO_CREATE_CHANNEL_COLLECTION`).
- **Ollama** running with `bge-m3` pulled (`ollama pull bge-m3`). Used for embeddings.
- An LLM: OpenAI-compatible endpoint (local llama.cpp/vLLM, or a hosted provider such as OpenRouter) **or** an Anthropic API key.
- Node.js 20+ (local dev) or Docker 24+ with Compose v2 (production).

## Configuration

Copy `.env.example` to `.env` and fill in required values.

### Core

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `MM_URL` | yes | — | Mattermost base URL |
| `MM_BOT_TOKEN` | yes | — | Bot account token |
| `MM_BOT_USERNAME` | yes | — | Bot's username (used in help text) |
| `MM_BOT_USER_ID` | no | auto-resolved | Bot user ID; resolved at startup if blank |
| `OUTLINE_URL` | yes | — | Outline base URL |
| `OUTLINE_API_TOKEN` | yes | — | Outline API token |
| `BOT_ADMINS` | no | — (everyone) | Usernames allowed to manage bot-wide collections and create collections |

### Collections

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `OUTLINE_COLLECTIONS` | no | — | Comma-separated collection names/URLs/IDs available in **every** channel (pinned; cannot be removed from chat) |
| `AUTO_CREATE_CHANNEL_COLLECTION` | no | `false` | Legacy behaviour: create and link a dedicated collection when the bot joins a channel |

Collections can be linked and unlinked at runtime from Mattermost — see [Managing collections](#managing-collections).

### LLM

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `LLM_BASE_URL` | no | — | OpenAI-compatible base URL. Both `http://localhost:8020` and `https://openrouter.ai/api/v1` styles work. When set, overrides Anthropic. |
| `LLM_MODEL` | no | `Qwen3.6-27B-UD-Q4_K_XL.gguf` | Model name, e.g. `anthropic/claude-sonnet-4.5` or `openai/gpt-4.1-mini` on OpenRouter |
| `LLM_API_KEY` | no | — | Bearer token for the endpoint (required by hosted providers) |
| `LLM_EXTRA_HEADERS` | no | — | Extra headers as JSON, e.g. `{"HTTP-Referer":"https://wiki.example.com","X-Title":"KB Bot"}` |
| `LLM_MAX_CONCURRENCY` | no | `1` | Parallel LLM calls. Keep `1` for single-slot llama.cpp, raise (e.g. `4`) for hosted providers |
| `LLM_TIMEOUT_MS` | no | `300000` | Per-request timeout |
| `LLM_MAX_OUTPUT_TOKENS` | no | `16000` | When a reply comes back empty or cut off (typical of reasoning models that spend the budget thinking), the bot retries with a doubled token budget up to this cap |
| `LLM_REASONING_EFFORT` | no | — | OpenRouter only: `low`/`medium`/`high` reasoning effort for thinking models; `low` makes saves faster and avoids empty replies |
| `LLM_NO_THINK_HINT` | no | `true` | Append Qwen's `/no_think` switch to prompts |
| `ANTHROPIC_API_KEY` | no | — | Anthropic API key (used only when `LLM_BASE_URL` is not set) |
| `ANTHROPIC_MODEL` | no | `claude-haiku-4-5-20251001` | Anthropic model |

Example for OpenRouter:

```env
LLM_BASE_URL=https://openrouter.ai/api/v1
LLM_API_KEY=sk-or-v1-...
LLM_MODEL=openai/gpt-4.1-mini
LLM_MAX_CONCURRENCY=4
LLM_NO_THINK_HINT=false
```

> Note: embeddings still run on Ollama (`OLLAMA_URL`), so the indexed wiki content never leaves your network; with a hosted LLM, however, the retrieved excerpts, the thread and the target document **are** sent to the provider.

### Embeddings

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `OLLAMA_URL` | no | `http://ollama:11434` | Ollama endpoint for bge-m3 embeddings |
| `INDEX_SYNC_INTERVAL_MINUTES` | no | `60` | How often to re-index all Outline documents |

### Questions

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `GENERAL_QA_ENABLED` | no | `true` | Allow answers that don't come from the wiki (`chiedi`, and fallback for free-text questions) |
| `SEARCH_SCORE_THRESHOLD` | no | `0.3` | Minimum similarity for a chunk to count as relevant |

### Saving (human-in-the-loop)

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `SAVE_APPROVAL_MODE` | no | `always` | `always`: every change needs approval. `auto_high_conf`: changes with confidence ≥ threshold that don't replace existing content are applied directly |
| `CONFIRMATION_CONFIDENCE_THRESHOLD` | no | `0.85` | Threshold for `auto_high_conf` |
| `SAVE_APPROVERS` | no | — | Usernames who may approve anyone's proposals (the requester always can) |
| `SAVE_CHANGELOG_HEADING` | no | `Storico aggiornamenti` | Section where the audit line is appended in each touched document; empty disables it |
| `CONFIRMATION_TTL_MINUTES` | no | `60` | Minutes before an unanswered proposal expires |
| `CLEANUP_INTERVAL_MINUTES` | no | `5` | How often expired proposals are swept |

### HTTP API / Widget

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `API_PORT` | no | `3333` | Port for the widget API server |
| `API_CORS_ORIGIN` | no | `*` | CORS `Access-Control-Allow-Origin` header |

### Storage / Logging

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `DB_PATH` | no | `./data/kb-bot.db` | SQLite database path |
| `LOG_LEVEL` | no | `info` | `debug`, `info`, `warn`, or `error` |

## Local development

```bash
npm install
cp .env.example .env
# fill in .env
npm run dev        # hot-reload via tsx watch
npm test           # unit + integration tests (no network)
npm run typecheck  # TypeScript strict check
```

## Production deployment

```bash
git clone https://github.com/manudarp/mattermost-knowledge-bot /opt/kb-bot
cd /opt/kb-bot
cp .env.example .env
# populate the required vars in .env

mkdir -p data && chown -R 1000:1000 data
docker compose up -d --build
docker compose logs -f
```

Expected startup log sequence:
```
db_ready
pinned_collections_resolved   (when OUTLINE_COLLECTIONS is set)
primary_team_resolved
confirmation_cleanup_started
embedding_model_ready        (or embedding_model_not_ready_search_disabled)
api_server_started
ws_connected
ws_authenticated
outline_index_sync_start
outline_index_sync_done
```

To update: `git pull && docker compose up -d --build`. Database migrations run automatically; existing channels keep their collection, which becomes the first linked collection.

### Network topology

The Docker Compose file joins an external `pm-network` and includes an Ollama sidecar. If you run the local LLM on a separate machine (e.g. a GPU server), connect the bot's VPS to it via **Tailscale** and set `LLM_BASE_URL` to the Tailscale IP.

```
[VPS: kb-bot + ollama]  ──Tailscale──▶  [GPU server: llama.cpp :8020]
```

## How to use

In channels, mention the bot. In a direct message with the bot, no mention is needed.

### Ask questions

```
@wikibot qual è lo stato del progetto ACME?      # wiki when relevant, otherwise general knowledge
@wikibot cerca procedura di onboarding           # wiki only, with sources
@wikibot chiedi come si scrive una regex per le email   # general AI, the wiki is not consulted
```

Answers based on the wiki cite their sources; general answers are labelled as such. Inside a thread, the previous messages are passed as context, so follow-up questions work.

### Save knowledge to Outline

Inside a thread reply:

```
@wikibot salva
@wikibot salva aggiorna la fase 2 del progetto ACME per il cliente Globex
```

The bot replies with a proposal such as:

> 📝 **Proposta di modifica alla knowledge base** · #12
> **Azione:** ✏️ aggiornare *Globex — ACME — Fase 2*
> **Percorso:** Clienti › Globex › ACME › Globex — ACME — Fase 2
> **Confidenza:** 88% — Il thread riporta il completamento del collaudo della fase 2…
> **Modifiche proposte:** ✏️ Sostituisce «Stato» … ➕ Aggiunge a «Attività» …

Then, as the requester (or an approver):

| Reply / reaction | Effect |
|---|---|
| 👍 ✅ or `ok` / `conferma` | apply the change |
| 👎 ❌ or `annulla` | discard it |
| `doc: <link or title>` | update that document instead (content is regenerated) |
| `collezione: <name>` | create a new document in that collection instead |
| `sotto: <link or title>` | create a new document nested under that document |
| `titolo: <title>` | change the title of the new document |
| `nota: <instructions>` | regenerate the proposal following the instructions |

Attachments are uploaded to the target document on approval and linked in the audit line. Attachments whose text can't be extracted (scanned PDFs, images) are flagged in the proposal.

### Managing collections

```
@wikibot collezioni                              # collections used in this channel (env / global / channel)
@wikibot collezioni disponibili                  # every collection the Outline token can see
@wikibot collezioni aggiungi Clienti, Procedure  # link to this channel (names, URLs or IDs)
@wikibot collezioni rimuovi Procedure            # unlink from this channel (Outline is untouched)
@wikibot collezioni aggiungi globale Handbook    # link for all channels (BOT_ADMINS)
@wikibot collezioni crea Nuovi clienti           # create in Outline and link (BOT_ADMINS)
```

A channel uses the union of: collections pinned in `OUTLINE_COLLECTIONS`, global links and its own links. If a channel has no collection at all, questions search the whole indexed wiki and saves are refused until a collection is linked.

### Outline widget

The widget is a floating chat bubble that appears on every Outline page. Embed it by injecting the script via your Outline reverse proxy:

**nginx** (`sub_filter` + proxy):
```nginx
location /kb/ {
    proxy_pass http://<kb-bot-host>:3333/;
}

sub_filter '</body>' '<script src="/kb/widget.js"></script></body>';
sub_filter_once on;
```

The widget automatically scopes search to the current context:
- On a `/doc/*` page → searches only that document first, falls back to full wiki
- On a `/collection/*` page → searches only that collection first, falls back to full wiki
- On any other page → searches the full wiki

### Other commands

```
@wikibot help    # usage instructions
@wikibot status  # linked collections, pending proposals, last save, LLM in use
```

## RAG pipeline

1. **Indexing** (background, every `INDEX_SYNC_INTERVAL_MINUTES`, and immediately after each applied save): fetches all Outline documents, splits into chunks by `##` heading, embeds via bge-m3 (Ollama), stores in SQLite with the document's collection. Moved documents are re-tagged, deleted ones are dropped.
2. **Search**: embeds the query, computes cosine similarity against the chunks of the channel's collections, returns top-K.
3. **Generation**: top-K chunks are passed as context to the LLM, which answers with source citations (or falls back to general knowledge when allowed).

## Troubleshooting

**Bot doesn't respond**
Check `ws_authenticated` appears in logs. Verify `MM_URL` and `MM_BOT_TOKEN`.

**"Nessuna collection Outline collegata"**
Link one with `@wikibot collezioni aggiungi <nome>` or set `OUTLINE_COLLECTIONS`. Check `pinned_collection_not_found` warnings in the logs for typos.

**Search returns no results**
Check `embedding_model_ready` in startup logs. Verify Ollama is running and `bge-m3` is pulled. If `outline_index_sync_done` shows `indexed: 0`, check `OUTLINE_URL` and `OUTLINE_API_TOKEN`. Right after upgrading, documents are re-indexed on the first sync.

**LLM errors**
For local LLMs, check `LLM_BASE_URL` is reachable from the bot container. For hosted providers, check `LLM_API_KEY` and `LLM_MODEL` (401/404 errors are not retried). If using Anthropic, verify `ANTHROPIC_API_KEY`.

**"il modello ha restituito una risposta vuota"**
Usually a reasoning model (R1, o-series, Qwen thinking…) that used its whole token budget on reasoning. The bot already retries with a larger budget; if it keeps happening, set `LLM_REASONING_EFFORT=low` (OpenRouter), raise `LLM_MAX_OUTPUT_TOKENS`, or use a non-reasoning model. The log line `ai_*_empty_or_truncated` shows `finish_reason` and the tokens used.

**Proposal can't be applied ("il documento è cambiato…")**
Someone edited or removed a section the proposal targeted. Reply `nota: rigenera` to redraft it against the current version.

**Widget returns 404 on `/kb/search`**
Your Outline reverse proxy is not forwarding `/kb/` to the bot. Add the `location /kb/` proxy block shown above.

**Database issues**
Ensure `./data` is writable by UID 1000: `chown -R 1000:1000 data`. A `SQLITE_CANTOPEN` error at startup means the directory permissions are wrong.

## Testing

```bash
npm test
```

Tests (no network, no `.env` required):
- `commandParser.test.ts` — commands, collection sub-commands, proposal replies
- `markdownSections.test.ts` — section-level document edits
- `outlineRefs.test.ts` — collection/document reference resolution, LLM URL building
- `migrations.test.ts` — upgrade of a legacy database
- `smartSave.test.ts` — end-to-end save flow with fake Outline/Mattermost/LLM
- `slugify.test.ts`, `helpers.test.ts`

## License

MIT
