import { z } from "zod";
import { callModelJson } from "../ai/jsonCall.js";
import { noThinkHint } from "../ai/client.js";

/**
 * Query decomposition. A question with several distinct parts ("gestione
 * documenti in Gestionale 1 e in AHRW?", "differenze tra ferie e permessi")
 * is rewritten into 2–3 self-contained search queries, each searched on its
 * own: in a single search the part with more documentation would take every
 * candidate slot. A short follow-up in a thread ("e per gli acquisti?") is
 * rewritten into a complete question using the conversation.
 */

export const MAX_SUBQUERIES = 3;

const SYSTEM_PROMPT = `Trasformi la domanda di un utente in query di ricerca per la knowledge base aziendale. Non rispondi alla domanda.
- Se la domanda contiene più richieste distinte (su prodotti, procedure o argomenti diversi), separala in 2 o 3 domande autonome, una per richiesta.
- Altrimenti restituisci UNA sola domanda.
- Ogni domanda deve essere comprensibile da sola: se fa riferimento alla conversazione precedente (es. "e per gli acquisti?"), completala con il contesto necessario.
- Mantieni termini tecnici, nomi di prodotti e sigle così come sono. Non aggiungere argomenti che l'utente non ha chiesto.
Rispondi SOLO con un oggetto JSON: {"queries":["domanda 1", ...]}`;

const QueriesSchema = z.object({
  queries: z.array(z.string().trim().min(2)).min(1),
});

const FOLLOW_UP_MAX_WORDS = 8;
// Words that often join two separate requests. Cheap pre-check, so most
// single-topic questions don't pay for an extra LLM call.
const MULTI_PART = /\b(e|ed|oppure|o|sia|vs|versus|rispetto|differenz\w*|confront\w*|mentre|invece)\b/i;

function wordCount(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

/** Whether a question is worth an LLM rewrite: possibly multi-part, or a short follow-up. */
export function shouldDecompose(query: string, hasConversation: boolean): boolean {
  const words = wordCount(query);
  if (hasConversation && words <= FOLLOW_UP_MAX_WORDS) return true;
  if (words < 5) return false;
  return MULTI_PART.test(query) || (query.match(/\?/g)?.length ?? 0) >= 2;
}

export async function decomposeQuery(opts: {
  query: string;
  conversationHint?: string;
  glossaryNote?: string;
}): Promise<string[]> {
  const hint = noThinkHint();
  const userPrompt =
    (hint ? `${hint}\n\n` : "") +
    (opts.conversationHint ? `Conversazione precedente:\n${opts.conversationHint}\n\n` : "") +
    (opts.glossaryNote ? `Sigle e sinonimi: ${opts.glossaryNote}\n\n` : "") +
    `Domanda: ${opts.query}`;

  const result = await callModelJson({
    name: "decompose",
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    schema: QueriesSchema,
    maxTokens: 600,
    temperature: 0,
    attempts: 2,
  });
  const unique = [...new Map(result.queries.map((q) => [q.toLowerCase(), q])).values()];
  return unique.slice(0, MAX_SUBQUERIES);
}
