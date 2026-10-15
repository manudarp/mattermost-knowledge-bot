import { callModel, noThinkHint } from "../ai/client.js";
import type { RetrievedChunk } from "./retrieval.js";

export interface SearchAnswer {
  answer: string;
  sources: Array<{ docId: string; title: string; url: string; heading: string }>;
}

/**
 *  kb      → answer ONLY from the retrieved context (`cerca`, Outline widget)
 *  hybrid  → prefer the context, complete with general knowledge, say which is which
 *  general → plain assistant, no knowledge-base context (`chiedi`)
 */
export type AnswerMode = "kb" | "hybrid" | "general";

export interface ConversationMessage {
  username: string;
  message: string;
  isBot: boolean;
}

export interface GenerateAnswerOpts {
  mode?: AnswerMode;
  scopeLabel?: string;
  /** Earlier messages of the Mattermost thread, oldest first, for follow-up questions. */
  conversation?: ConversationMessage[];
}

const MAX_CONVERSATION_CHARS = 6000;

function renderConversation(conv: ConversationMessage[] | undefined): string {
  if (!conv || conv.length === 0) return "";
  const lines: string[] = [];
  let budget = MAX_CONVERSATION_CHARS;
  // Keep the most recent messages when over budget.
  for (const m of [...conv].reverse()) {
    const line = `${m.isBot ? "Assistente" : `@${m.username}`}: ${m.message.slice(0, 1500)}`;
    if (line.length > budget) break;
    budget -= line.length;
    lines.unshift(line);
  }
  return `Conversazione precedente nel thread (dalla più vecchia):\n${lines.join("\n")}\n\n`;
}

function systemPromptFor(mode: AnswerMode, scopeLabel?: string): string {
  const scopeNote = scopeLabel
    ? ` Priorità ai contenuti di ${scopeLabel}, ma puoi usare anche il contesto più ampio se necessario.`
    : "";

  switch (mode) {
    case "kb":
      return `Sei un assistente aziendale. Rispondi alle domande degli utenti usando SOLO le informazioni fornite nel contesto.${scopeNote}
Se il contesto non contiene informazioni sufficienti, dillo chiaramente.
Rispondi in italiano. Sii conciso (max 3-4 paragrafi). Cita le fonti con [numero].`;
    case "hybrid":
      return `Sei un assistente aziendale con accesso alla knowledge base interna.${scopeNote}
Usa prima di tutto le informazioni del contesto fornito e citale con [numero].
Se il contesto non basta o la domanda è di carattere generale, integra con le tue conoscenze,
indicando chiaramente quali parti NON provengono dalla knowledge base (es. "In generale, …").
Non inventare fatti specifici dell'azienda (clienti, progetti, decisioni) che non sono nel contesto.
Rispondi nella lingua della domanda (di default italiano). Sii conciso e concreto.`;
    case "general":
      return `Sei un assistente utile e preciso che risponde ai colleghi su Mattermost.
Rispondi nella lingua della domanda (di default italiano), in modo conciso e concreto, usando Markdown quando aiuta.
Se non sei sicuro di qualcosa, dillo. Non hai accesso a informazioni interne dell'azienda in questa risposta.`;
  }
}

export async function generateAnswer(
  query: string,
  chunks: RetrievedChunk[],
  optsOrScopeLabel?: GenerateAnswerOpts | string,
): Promise<SearchAnswer> {
  const opts: GenerateAnswerOpts =
    typeof optsOrScopeLabel === "string" ? { scopeLabel: optsOrScopeLabel } : (optsOrScopeLabel ?? {});
  const mode = opts.mode ?? "kb";
  const useContext = mode !== "general" && chunks.length > 0;

  const context = useContext
    ? chunks.map((c, i) => `[${i + 1}] **${c.docTitle} › ${c.heading}**\n${c.content}`).join("\n\n---\n\n")
    : "";

  // `/no_think` tells Qwen 3.x to skip chain-of-thought — for a grounded Q&A
  // we want the answer, not the reasoning trace (and a long <think> phase
  // was eating the maxTokens budget, leaving the answer empty after strip).
  const hint = noThinkHint();
  const userPrompt = `${hint ? `${hint}\n\n` : ""}${renderConversation(opts.conversation)}Domanda: ${query}${
    useContext ? `\n\nContesto (knowledge base):\n${context}` : ""
  }`;

  const { text } = await callModel({
    systemPrompt: systemPromptFor(mode, opts.scopeLabel),
    userPrompt,
    maxTokens: 4000,
    temperature: mode === "general" ? 0.5 : 0.2,
  });

  const sources = useContext
    ? chunks.map((c) => ({
        docId: c.docId,
        title: c.docTitle,
        url: c.docUrl,
        heading: c.heading,
      }))
    : [];

  return { answer: text, sources };
}
