import { z } from "zod";
import { callModelJson } from "../ai/jsonCall.js";
import { noThinkHint } from "../ai/client.js";

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

const PASSAGE_CHARS = 700;

const SYSTEM_PROMPT = `Valuti la pertinenza di passaggi di documentazione aziendale rispetto alla domanda di un utente.
Per ogni passaggio assegna un punteggio:
3 = risponde direttamente alla domanda
2 = contiene informazioni utili per rispondere
1 = solo marginale: argomento collegato, caso particolare, integrazione con un altro prodotto o scenario specifico che la domanda non menziona
0 = non pertinente

Valuta rispetto a ciò che la domanda chiede davvero. Se la domanda è generale, i passaggi su casi particolari,
integrazioni o configurazioni specifiche valgono al massimo 1, a meno che la domanda li citi.
Se la domanda riguarda un prodotto specifico, i passaggi su un prodotto diverso valgono 0.
Rispondi SOLO con un oggetto JSON: {"scores":[{"id":<numero passaggio>,"score":<0-3>}, ...]} con tutti i passaggi.`;

const ScoresSchema = z.object({
  scores: z.array(z.object({ id: z.coerce.number().int(), score: z.coerce.number().min(0).max(3) })),
});

/** Returns one score (0–3) per passage, in input order. Throws when the model can't produce a valid ranking. */
export async function rerankPassages(opts: {
  query: string;
  passages: RerankPassage[];
  conversationHint?: string;
  glossaryNote?: string;
}): Promise<number[]> {
  const { query, passages } = opts;
  const list = passages
    .map((p, i) => {
      const body = p.content.length > PASSAGE_CHARS ? `${p.content.slice(0, PASSAGE_CHARS)}…` : p.content;
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
