import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

process.env.SEARCH_GLOSSARY = "AHRW = Ad hoc Revolution Web";
process.env.SEARCH_RERANK = "true";

// Fake embedding: one dimension per topic word.
const DIMS = ["document", "vendit", "traxal", "magazzin", "ricett"];
let embeddingDown = false;
function fakeVec(text: string): number[] {
  const t = text.toLowerCase();
  return DIMS.map((d) => (t.includes(d) ? 1 : 0));
}
vi.mock("../../src/embedding/client.js", () => ({
  embeddingModelId: () => "test:fake",
  embed: vi.fn(async (texts: string[]) => texts.map(fakeVec)),
  embedOne: vi.fn(async (text: string) => fakeVec(text)),
  embedQuery: vi.fn(async (text: string) => {
    if (embeddingDown) throw new Error("down");
    return fakeVec(text);
  }),
}));

// Fake re-ranker: rates the general page 3 and everything else 1 (marginal).
let rerankBroken = false;
const prompts: string[] = [];
vi.mock("../../src/ai/client.js", () => ({
  noThinkHint: () => "",
  callModel: vi.fn(async ({ userPrompt }: { userPrompt: string }) => {
    prompts.push(userPrompt);
    if (rerankBroken) throw new Error("provider down");
    const scores = [...userPrompt.matchAll(/^\[(\d+)\] (.*)$/gm)].map((m) => ({
      id: Number(m[1]),
      score: m[2]!.includes("Gestione documenti") ? 3 : 1,
    }));
    return { text: JSON.stringify({ scores }), usage: { input: 0, output: 0 }, finishReason: "stop", truncated: false, reasoned: false };
  }),
}));

const { indexDocument, ensureIndexMatchesEmbeddingModel } = await import("../../src/indexer/outlineIndexer.js");
const { search, searchWithTrace, ftsQuery } = await import("../../src/search/retrieval.js");
const { expandQuery, parseGlossaryDefinition, addGlossaryEntry, removeGlossaryEntry, listGlossary } = await import(
  "../../src/search/glossary.js"
);
const { parseGlossaryArgs } = await import("../../src/core/commandParser.js");

const client = {} as never;
const QUESTION = "Come funziona la gestione documenti su Ad hoc revolution web?";

beforeAll(async () => {
  ensureIndexMatchesEmbeddingModel();
  await indexDocument(
    client,
    "doc-general",
    "AHRW – Gestione documenti",
    "## Causali documento\nIn AHRW i documenti di vendita e di acquisto si creano a partire dalle causali documento, che definiscono numerazione, stampa ed evasione.",
    1,
    "/doc/general",
    "col",
  );
  await indexDocument(
    client,
    "doc-traxal",
    "Integrazione Traxal",
    "## AHRWTX_Docs\nL'azione AHRWTX_Docs pubblica i documenti AHRW verso Traxal: documenti con causale mappata. I documenti trasferiti non movimentano il magazzino.",
    1,
    "/doc/traxal",
    "col",
  );
  await indexDocument(
    client,
    "doc-noise",
    "Note varie",
    "## Elenco\nDocumenti da archiviare: ricette, verbali, documenti vari.",
    1,
    "/doc/noise",
    "col",
  );
});

beforeEach(() => {
  embeddingDown = false;
  rerankBroken = false;
  prompts.length = 0;
});

describe("glossary", () => {
  it("parses definitions and expands queries in both directions", () => {
    expect(parseGlossaryDefinition("G1 = Gestionale 1 | Gestionale uno")).toEqual(["G1", "Gestionale 1", "Gestionale uno"]);
    expect(parseGlossaryDefinition("solo")).toBeNull();
    expect(parseGlossaryDefinition("X = x")).toBeNull();

    const e = expandQuery(QUESTION);
    expect(e.note).toBe("AHRW = Ad hoc Revolution Web");
    expect(e.embeddingQuery).toContain("(AHRW)");
    expect(expandQuery("documenti in ahrw").embeddingQuery).toContain("Ad hoc Revolution Web");
    // Whole words only.
    expect(expandQuery("AHRWTX_Docs").matched).toEqual([]);
  });

  it("is editable from chat and parses chat commands", () => {
    expect(parseGlossaryArgs("")).toEqual({ action: "list" });
    expect(parseGlossaryArgs("aggiungi G1 = Gestionale 1")).toEqual({ action: "add", definition: "G1 = Gestionale 1" });
    expect(parseGlossaryArgs("G1 = Gestionale 1")).toEqual({ action: "add", definition: "G1 = Gestionale 1" });
    expect(parseGlossaryArgs("rimuovi G1")).toEqual({ action: "remove", term: "G1" });
    expect(parseGlossaryArgs("aggiungi G1").action).toBe("invalid");

    addGlossaryEntry(["G1", "Gestionale 1"]);
    expect(addGlossaryEntry(["G1", "Gestionale 1", "Gestionale uno"]).replaced).toBe(true);
    expect(listGlossary().map((x) => x.aliases[0])).toEqual(["AHRW", "G1"]);
    expect(removeGlossaryEntry("gestionale uno")).toBe("removed");
    expect(removeGlossaryEntry("AHRW")).toBe("env");
    expect(removeGlossaryEntry("ZZZ")).toBe("missing");
  });

  it("searches the acronym when the question spells the name out", () => {
    const fts = ftsQuery(QUESTION, expandQuery(QUESTION).matched)!;
    expect(fts).toContain('"ahrw"');
    expect(fts).toContain('"ad hoc revolution web"');
    // The words of the expanded name are not searched one by one ("web" alone is noise).
    expect(fts).not.toContain('"web"');
  });
});

describe("relevance filters", () => {
  it("keyword-only: a chunk matching just one generic word is not relevant", async () => {
    embeddingDown = true;
    const { chunks, trace } = await searchWithTrace(QUESTION, 8, undefined, { rerank: false });
    expect(chunks.map((c) => c.docId)).toContain("doc-general");
    expect(chunks.map((c) => c.docId)).not.toContain("doc-noise");
    expect(trace.candidates.find((c) => c.docTitle === "Note varie")?.verdict).toBe("poche parole della domanda");
  });
});

describe("LLM re-ranking", () => {
  it("keeps the passages that answer the question and drops marginal ones", async () => {
    const { chunks, trace } = await searchWithTrace(QUESTION, 8);
    expect(chunks.map((c) => c.docId)).toEqual(["doc-general"]);
    expect(trace.rerank).toBe("ok");
    expect(trace.candidates.find((c) => c.docTitle === "Integrazione Traxal")).toMatchObject({ rerankScore: 1, selected: false });
    // The re-ranker is told what the acronym means.
    expect(prompts[0]).toContain("AHRW = Ad hoc Revolution Web");
  });

  it("searches short follow-ups together with the previous question", async () => {
    // Alone, "e per gli acquisti?" matches nothing.
    expect(await search("e per gli acquisti?", 8, undefined, { rerank: false })).toEqual([]);

    const chunks = await search("e per gli acquisti?", 8, undefined, {
      conversationHint: "@anna: come funzionano i documenti in AHRW?",
      followUpOf: "come funzionano i documenti in AHRW?",
    });
    expect(chunks.map((c) => c.docId)).toEqual(["doc-general"]);
    // The re-ranker judges the real question, with the conversation as context.
    expect(prompts[0]).toContain("Domanda: e per gli acquisti?");
    expect(prompts[0]).toContain("@anna: come funzionano i documenti in AHRW?");
  });

  it("only treats short questions as follow-ups", async () => {
    const { followUpOf } = await import("../../src/core/questionFlow.js");
    const conv = [
      { username: "anna", message: "@kbtest come funzionano i documenti in AHRW?", isBot: false },
      { username: "kbtest", message: "Risposta…", isBot: true },
    ];
    expect(followUpOf("e per gli acquisti?", conv)).toBe("come funzionano i documenti in AHRW?");
    expect(followUpOf("spiegami nel dettaglio come si configura la numerazione dei documenti di vendita", conv)).toBeUndefined();
    expect(followUpOf("e per gli acquisti?", [])).toBeUndefined();
  });

  it("falls back to the hybrid order when the re-ranker fails", async () => {
    rerankBroken = true;
    const { chunks, trace } = await searchWithTrace(QUESTION, 8);
    expect(trace.rerank).toBe("failed");
    expect(chunks.length).toBeGreaterThan(0);
  });
});
