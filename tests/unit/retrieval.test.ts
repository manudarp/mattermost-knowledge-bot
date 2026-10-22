import { describe, it, expect, vi, beforeAll } from "vitest";

// Deterministic fake embedding: one dimension per topic word. "soap" is
// deliberately NOT a dimension, so only the keyword index can find it —
// exactly the weakness of pure semantic search on technical acronyms.
const DIMS = ["fattura", "cliente", "import", "log", "sincronizzazione"];
let embeddingDown = false;
function fakeVec(text: string): number[] {
  const t = text.toLowerCase();
  return DIMS.map((d) => (t.includes(d) ? 1 : 0));
}
vi.mock("../../src/embedding/client.js", () => ({
  embeddingModelId: () => "test:fake",
  embed: vi.fn(async (texts: string[]) => {
    if (embeddingDown) throw new Error("down");
    return texts.map(fakeVec);
  }),
  embedOne: vi.fn(async (text: string) => {
    if (embeddingDown) throw new Error("down");
    return fakeVec(text);
  }),
}));

const { indexDocument, ensureIndexMatchesEmbeddingModel } = await import("../../src/indexer/outlineIndexer.js");
const { search, searchDocuments, ftsQuery } = await import("../../src/search/retrieval.js");
const { db } = await import("../../src/db/index.js");

const client = {} as never;

beforeAll(async () => {
  ensureIndexMatchesEmbeddingModel();
  await indexDocument(
    client,
    "doc-gd",
    "Gestione dati – Approfondimenti",
    [
      "# Sincronizzatore",
      "La sincronizzazione dei dati avviene ogni notte.",
      "## Servizi web",
      "Il sincronizzatore espone servizi SOAP con WSDL pubblicato su /ws/sync?wsdl; le chiamate usano WS-Security.",
      "# Log",
      "I log di sincronizzazione riportano gli errori per entità.",
    ].join("\n"),
    1,
    "/doc/gestione-dati-approfondimenti-8px1eH5beH",
    "col-a",
  );
  await indexDocument(client, "doc-fatt", "Fatturazione", "## Fattura cliente\nCome emettere una fattura al cliente.", 1, "/doc/fatt", "col-a");
  await indexDocument(client, "doc-other", "Altro", "## Servizi SOAP legacy\nVecchi servizi SOAP non più usati.", 1, "/doc/other", "col-b");
});

describe("ftsQuery", () => {
  it("drops stopwords, quotes terms and uses prefix match on longer ones", () => {
    expect(ftsQuery("come funzionano le API SOAP del sincronizzatore?")).toBe(
      '"funzionano"* OR "api" OR "soap" OR "sincronizzatore"*',
    );
    expect(ftsQuery("e il la?")).toBeNull();
    // User quotes never reach FTS syntax; "con" is a stopword.
    expect(ftsQuery('test "con" virgolette')).toBe('"test" OR "virgolette"*');
  });
});

describe("hybrid search", () => {
  it("finds an exact technical term that the embedding cannot see (keyword match)", async () => {
    const res = await search("come funzionano le API SOAP?", 8, { collectionIds: ["col-a"] });
    expect(res[0]?.heading).toBe("Sincronizzatore › Servizi web");
    expect(res[0]?.keywordRank).toBe(1);
    // Scope respected: the SOAP doc in col-b is excluded.
    expect(res.some((c) => c.docId === "doc-other")).toBe(false);
  });

  it("still uses semantic similarity for paraphrases", async () => {
    const res = await search("emissione fattura", 8, { collectionIds: ["col-a"] });
    expect(res[0]?.docId).toBe("doc-fatt");
    expect(res[0]?.score).toBeGreaterThan(0.5);
  });

  it("returns nothing when nothing is relevant", async () => {
    expect(await search("ricetta della carbonara", 8, { collectionIds: ["col-a"] })).toEqual([]);
  });

  it("degrades to keyword-only search when the embedding backend is down", async () => {
    embeddingDown = true;
    try {
      const res = await search("WSDL", 8, { collectionIds: ["col-a"] });
      expect(res[0]?.docId).toBe("doc-gd");
      expect(res[0]?.score).toBe(0);
    } finally {
      embeddingDown = false;
    }
  });

  it("caps chunks per document", async () => {
    const res = await search("sincronizzazione sincronizzatore log", 8, { collectionIds: ["col-a"] }, { maxPerDoc: 1 });
    expect(res.filter((c) => c.docId === "doc-gd")).toHaveLength(1);
  });

  it("document-level search groups chunks and lists headings", async () => {
    const docs = await searchDocuments("servizi SOAP", 5, { collectionIds: ["col-a", "col-b"] });
    expect(docs.map((d) => d.docId)).toContain("doc-gd");
    expect(docs.find((d) => d.docId === "doc-gd")!.headings).toEqual(["Sincronizzatore", "Sincronizzatore › Servizi web", "Log"]);
  });

  it("re-indexing a document replaces its chunks and keeps the keyword index in sync", async () => {
    await indexDocument(client, "doc-other", "Altro", "## Nuovo\nOra parla di REST e JSON.", 2, "/doc/other", "col-b");
    expect(await search("SOAP legacy", 8, { collectionIds: ["col-b"] })).toEqual([]);
    expect((await search("REST JSON", 8, { collectionIds: ["col-b"] }))[0]?.heading).toBe("Nuovo");
  });

  it("changing embedding model wipes the index", async () => {
    db.prepare("UPDATE bot_settings SET value = 'old:model' WHERE key = 'embedding_model'").run();
    ensureIndexMatchesEmbeddingModel();
    expect((db.prepare("SELECT COUNT(*) AS n FROM document_chunks").get() as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM chunks_fts").get() as { n: number }).n).toBe(0);
  });
});
