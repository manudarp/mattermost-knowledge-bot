import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

process.env.SEARCH_RERANK = "true";
process.env.SEARCH_DECOMPOSE = "false";

// Fake embedding that knows nothing about field names: only exact keyword
// matching can find "TIPDOC".
vi.mock("../../src/embedding/client.js", () => ({
  embeddingModelId: () => "test:fake",
  embed: vi.fn(async (texts: string[]) => texts.map((t) => [t.toLowerCase().includes("vendit") ? 1 : 0, 1])),
  embedOne: vi.fn(async () => [0, 1]),
  embedQuery: vi.fn(async () => [0, 1]),
}));

// A strict re-ranker that rates everything 0 or 1, and records what it was shown.
let rerankScore = 1;
const prompts: string[] = [];
vi.mock("../../src/ai/client.js", () => ({
  noThinkHint: () => "",
  callModel: vi.fn(async ({ userPrompt }: { userPrompt: string }) => {
    prompts.push(userPrompt);
    const scores = [...userPrompt.matchAll(/^\[(\d+)\] /gm)].map((m) => ({ id: Number(m[1]), score: rerankScore }));
    return { text: JSON.stringify({ scores }), usage: { input: 0, output: 0 }, finishReason: "stop", truncated: false, reasoned: false };
  }),
}));

const { indexDocument, ensureIndexMatchesEmbeddingModel } = await import("../../src/indexer/outlineIndexer.js");
const { searchWithTrace } = await import("../../src/search/retrieval.js");
const { focusWindow } = await import("../../src/search/rerank.js");

const client = {} as never;
// The answer sits in a table far past the first 800 characters of the chunk.
const FILLER = "Il tracciato contiene i dati di testata del documento esportato verso il gestionale. ".repeat(14);
const TRACCIATO = `## Tracciato documenti\n${FILLER}\n\n| Campo | Descrizione |\n|---|---|\n| TIPDOC | Tipo documento: FV fattura, DDT documento di trasporto |`;

beforeAll(async () => {
  ensureIndexMatchesEmbeddingModel();
  // A realistic index: many chunks, so a term found in one of them is rare.
  const sections = Array.from({ length: 400 }, (_, i) => `## Sezione ${i}\nNote generali numero ${i} sui documenti di vendita e sul tracciato.`).join("\n\n");
  await indexDocument(client, "doc-filler", "Note varie", sections, 1, "/doc/filler", "col");
  await indexDocument(client, "doc-g1", "G1 – Tracciati di esportazione", TRACCIATO, 1, "/doc/g1", "col");
});

beforeEach(() => {
  rerankScore = 1;
  prompts.length = 0;
});

describe("focusWindow", () => {
  it("shows the part of a long passage that contains the query terms", () => {
    const w = focusWindow(TRACCIATO, ["tipdoc", "tracciat"], 300);
    expect(w).toContain("TIPDOC");
    expect(w.startsWith("…")).toBe(true);
    expect(w.length).toBeLessThanOrEqual(302);
    // No term found → plain prefix.
    expect(focusWindow(TRACCIATO, ["inesistente"], 100)).toBe(`${TRACCIATO.slice(0, 100)}…`);
    expect(focusWindow("breve", ["x"], 100)).toBe("breve");
  });
});

describe("rare terms", () => {
  it("finds an exact field name and keeps it even when the re-ranker rates it low", async () => {
    const { chunks, trace } = await searchWithTrace("cosa rappresenta il campo TIPDOC nel tracciato dei documenti?", 8);
    expect(chunks.map((c) => c.docId)).toContain("doc-g1");
    const t = trace.candidates.find((c) => c.docTitle.startsWith("G1"));
    expect(t?.verdict).toContain("tenuto: termine raro");
    // The re-ranker was shown the table row, not just the first 800 characters.
    expect(prompts[0]).toContain("| TIPDOC | Tipo documento");
  });

  it("when the re-ranker rejects everything, the best non-zero passages still reach the answer", async () => {
    const { chunks, trace } = await searchWithTrace("note generali sui documenti di vendita", 8);
    expect(trace.rerank).toBe("ok");
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.length).toBeLessThanOrEqual(3);
    expect(trace.candidates.some((c) => c.verdict.includes("nessuno sopra soglia"))).toBe(true);
  });

  it("returns nothing when the re-ranker rates every passage 0", async () => {
    rerankScore = 0;
    const { chunks } = await searchWithTrace("note generali sui documenti di vendita", 8);
    expect(chunks).toEqual([]);
  });
});
