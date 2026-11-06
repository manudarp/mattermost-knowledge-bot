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

// Fake LLM. Decomposition: echoes the question unless `decomposeReply` is set.
// Re-ranker: rates the general page 3 and everything else 1 (marginal).
let rerankBroken = false;
let decomposeBroken = false;
let decomposeReply: string[] | null = null;
const prompts: string[] = [];
const decomposePrompts: string[] = [];
const llmReply = (text: string) => ({ text, usage: { input: 0, output: 0 }, finishReason: "stop", truncated: false, reasoned: false });
vi.mock("../../src/ai/client.js", () => ({
  noThinkHint: () => "",
  callModel: vi.fn(async ({ systemPrompt, userPrompt }: { systemPrompt: string; userPrompt: string }) => {
    if (systemPrompt.includes("query di ricerca")) {
      decomposePrompts.push(userPrompt);
      if (decomposeBroken) throw new Error("provider down");
      const question = /^Domanda: (.*)$/m.exec(userPrompt)?.[1] ?? "";
      return llmReply(JSON.stringify({ queries: decomposeReply ?? [question] }));
    }
    prompts.push(userPrompt);
    if (rerankBroken) throw new Error("provider down");
    const scores = [...userPrompt.matchAll(/^\[(\d+)\] (.*)$/gm)].map((m) => ({
      id: Number(m[1]),
      score: m[2]!.includes("Gestione documenti") ? 3 : 1,
    }));
    return llmReply(JSON.stringify({ scores }));
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
  decomposeBroken = false;
  decomposeReply = null;
  prompts.length = 0;
  decomposePrompts.length = 0;
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

describe("several glossary entries", () => {
  it("parses several definitions in one command, including the 'X = Y | Z = W' form", async () => {
    const { parseGlossaryDefinitions } = await import("../../src/search/glossary.js");
    expect(parseGlossaryDefinitions("AHRW = Ad Hoc Revolution Web | G1 = Gestionale 1")).toEqual([
      ["AHRW", "Ad Hoc Revolution Web"],
      ["G1", "Gestionale 1"],
    ]);
    expect(parseGlossaryDefinitions("A = Alfa | Alpha; B = Beta")).toEqual([
      ["A", "Alfa", "Alpha"],
      ["B", "Beta"],
    ]);
  });

  it("repairs an entry saved as one before multi-definition parsing", async () => {
    const { db } = await import("../../src/db/index.js");
    db.prepare("INSERT INTO bot_settings (key, value) VALUES ('search_glossary', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
      JSON.stringify([["XY", "Ics Ipsilon", "ZW = Zeta Doppio"]]),
    );
    expect(listGlossary().filter((e) => e.source === "chat").map((e) => e.aliases)).toEqual([
      ["XY", "Ics Ipsilon"],
      ["ZW", "Zeta Doppio"],
    ]);
    db.prepare("DELETE FROM bot_settings WHERE key = 'search_glossary'").run();
  });

  it("glossary entries alone never split a search", async () => {
    addGlossaryEntry(["G1", "Gestionale 1"]);
    try {
      const { trace } = await searchWithTrace("come funziona la gestione documenti su Gestionale 1 e su AHRW?", 8, undefined, {
        rerank: false,
        decompose: false,
      });
      expect(trace.passes).toHaveLength(1);
      expect(trace.passes[0]!.query).toBe("come funziona la gestione documenti su Gestionale 1 e su AHRW?");
    } finally {
      removeGlossaryEntry("G1");
    }
  });
});

describe("query decomposition", () => {
  it("only calls the LLM for questions that look multi-part or are follow-ups", async () => {
    const { shouldDecompose } = await import("../../src/search/decompose.js");
    expect(shouldDecompose("come funziona la gestione documenti su Gestionale 1 e su AHRW?", false)).toBe(true);
    expect(shouldDecompose("differenze tra ferie e permessi retribuiti", false)).toBe(true);
    expect(shouldDecompose("come si configura la numerazione dei documenti di vendita", false)).toBe(false);
    expect(shouldDecompose("ferie?", false)).toBe(false);
    expect(shouldDecompose("e per gli acquisti?", true)).toBe(true);

    const { trace } = await searchWithTrace("come si configura la numerazione dei documenti di vendita", 8, undefined, { rerank: false });
    expect(trace.decomposition).toBe("skipped");
    expect(decomposePrompts).toEqual([]);
  });

  it("searches each part of a multi-part question separately and merges the results", async () => {
    await indexDocument(
      client,
      "doc-g1",
      "Vendite",
      "## Documenti di vendita\nIn Gestionale 1 i documenti di vendita si emettono dal menu Vendite.",
      1,
      "/doc/g1",
      "col",
    );
    decomposeReply = ["gestione documenti di vendita in Gestionale 1", "gestione documenti in Ad hoc Revolution Web"];
    const { chunks, trace } = await searchWithTrace("come funziona la gestione documenti su Gestionale 1 e su AHRW?", 8, undefined, {
      rerank: false,
    });
    expect(trace.decomposition).toBe("split");
    expect(trace.passes.map((p) => [p.label, p.query])).toEqual([
      ["#1", "gestione documenti di vendita in Gestionale 1"],
      ["#2", "gestione documenti in Ad hoc Revolution Web"],
    ]);
    const docs = chunks.map((c) => c.docId);
    expect(docs).toContain("doc-general");
    expect(docs).toContain("doc-g1");
    expect(trace.candidates.find((c) => c.docTitle === "Vendite")?.via).toBe("#1");

    const { renderTrace } = await import("../../src/core/searchCommands.js");
    const text = renderTrace(trace, "tutta la wiki");
    expect(text).toContain("2 ricerche separate");
    expect(text).toContain("**Ricerca #1:** _gestione documenti di vendita in Gestionale 1_");
    expect(text).toMatch(/\| Vendite › Documenti di vendita \| #1 \|/);
  });

  it("falls back to a single search when the decomposition fails", async () => {
    decomposeBroken = true;
    const { chunks, trace } = await searchWithTrace("come funziona la gestione documenti su Gestionale 1 e su AHRW?", 8, undefined, {
      rerank: false,
    });
    expect(trace.decomposition).toBe("failed");
    expect(trace.passes).toHaveLength(1);
    expect(chunks.length).toBeGreaterThan(0);
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

  it("searches short follow-ups together with the previous question when decomposition is off", async () => {
    // Alone, "e per gli acquisti?" matches nothing.
    expect(await search("e per gli acquisti?", 8, undefined, { rerank: false, decompose: false })).toEqual([]);

    const chunks = await search("e per gli acquisti?", 8, undefined, {
      conversationHint: "@anna: come funzionano i documenti in AHRW?",
      followUpOf: "come funzionano i documenti in AHRW?",
      decompose: false,
    });
    expect(chunks.map((c) => c.docId)).toEqual(["doc-general"]);
    // The re-ranker judges the real question, with the conversation as context.
    expect(prompts[0]).toContain("Domanda: e per gli acquisti?");
    expect(prompts[0]).toContain("@anna: come funzionano i documenti in AHRW?");
  });

  it("rewrites a follow-up into a complete question with the conversation", async () => {
    decomposeReply = ["come funzionano i documenti di acquisto in AHRW?"];
    const { chunks, trace } = await searchWithTrace("e per gli acquisti?", 8, undefined, {
      conversationHint: "@anna: come funzionano i documenti in AHRW?",
      followUpOf: "come funzionano i documenti in AHRW?",
    });
    expect(decomposePrompts[0]).toContain("@anna: come funzionano i documenti in AHRW?");
    expect(trace.decomposition).toBe("single");
    expect(trace.passes.map((p) => p.query)).toEqual(["come funzionano i documenti di acquisto in AHRW?"]);
    expect(chunks.map((c) => c.docId)).toEqual(["doc-general"]);
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
