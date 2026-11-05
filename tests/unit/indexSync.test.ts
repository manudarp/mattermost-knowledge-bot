import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.OUTLINE_REQUEST_DELAY_MS = "0";

const embedCalls: string[][] = [];
vi.mock("../../src/embedding/client.js", () => ({
  embeddingModelId: () => "test:fake",
  embed: vi.fn(async (texts: string[]) => {
    embedCalls.push(texts);
    return texts.map(() => [1, 0, 0]);
  }),
  embedOne: vi.fn(async () => [1, 0, 0]),
}));

const { runFullSync, ensureIndexMatchesEmbeddingModel, indexSingleDocument, lastSyncResult, currentSyncProgress } = await import("../../src/indexer/outlineIndexer.js");
const { HttpError } = await import("../../src/utils/retry.js");
const { parseRetryAfter } = await import("../../src/outline/client.js");
const { db } = await import("../../src/db/index.js");

interface FakeDoc {
  id: string;
  title: string;
  text: string;
  revision: number;
  updatedAt: string;
}

const LONG = Array.from({ length: 12 }, (_, i) => `## Sezione ${i}\n${"Contenuto descrittivo della sezione. ".repeat(20)}`).join("\n\n");

function makeOutline(docs: FakeDoc[]) {
  const infoCalls: string[] = [];
  const failing = new Set<string>();
  const unreachable = new Set<string>();
  const hiddenFromList = new Set<string>();
  const client = {
    async post(endpoint: string, body: Record<string, unknown>) {
      if (endpoint === "/documents.list") {
        if ((body.offset as number) > 0) return [];
        // The list only carries a truncated text, like Outline's.
        return docs.filter((d) => !hiddenFromList.has(d.id)).map((d) => ({ ...d, text: d.text.slice(0, 50), url: `/doc/${d.id}`, collectionId: "col" }));
      }
      if (endpoint === "/documents.info") {
        const id = String(body.id);
        infoCalls.push(id);
        if (failing.has(id)) throw new HttpError(429, "rate_limit_exceeded", "HTTP 429 POST /documents.info");
        if (unreachable.has(id)) throw new Error("fetch failed: network");
        const d = docs.find((x) => x.id === id);
        if (!d) throw new HttpError(404, "not_found", "HTTP 404 POST /documents.info");
        return { ...d, url: `/doc/${d.id}`, collectionId: "col" };
      }
      throw new Error(`unexpected ${endpoint}`);
    },
  };
  return { client: client as never, infoCalls, failing, unreachable, hiddenFromList };
}

const chunkChars = (docId: string) =>
  (db.prepare("SELECT COALESCE(SUM(length(content)),0) AS n FROM document_chunks WHERE doc_id = ?").get(docId) as { n: number }).n;

beforeEach(() => {
  db.prepare("DELETE FROM document_chunks").run();
  db.prepare("DELETE FROM index_state").run();
  ensureIndexMatchesEmbeddingModel();
  embedCalls.length = 0;
});

describe("index sync", () => {
  it("downloads and embeds only documents changed since the last sync", async () => {
    const docs: FakeDoc[] = [
      { id: "a", title: "A", text: LONG, revision: 1, updatedAt: "2026-11-01T10:00:00Z" },
      { id: "b", title: "B", text: "## X\nTesto del documento B abbastanza lungo.", revision: 1, updatedAt: "2026-11-01T11:00:00Z" },
    ];
    const outline = makeOutline(docs);

    await runFullSync(outline.client);
    expect(outline.infoCalls).toEqual(["a", "b"]);
    expect(chunkChars("a")).toBeGreaterThan(LONG.length * 0.8);

    // Nothing changed → no documents.info, no embeddings.
    outline.infoCalls.length = 0;
    embedCalls.length = 0;
    await runFullSync(outline.client);
    expect(outline.infoCalls).toEqual([]);
    expect(embedCalls).toEqual([]);

    // One document edited → only that one is downloaded again.
    docs[1]!.text += "\nNuova riga aggiunta.";
    docs[1]!.revision = 2;
    docs[1]!.updatedAt = "2026-11-05T09:00:00Z";
    await runFullSync(outline.client);
    expect(outline.infoCalls).toEqual(["b"]);
  });

  it("never indexes the truncated list text when documents.info fails, and retries next time", async () => {
    const docs: FakeDoc[] = [{ id: "a", title: "A", text: LONG, revision: 1, updatedAt: "2026-11-01T10:00:00Z" }];
    const outline = makeOutline(docs);
    outline.failing.add("a");

    await runFullSync(outline.client);
    expect(chunkChars("a")).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM index_state WHERE doc_id = 'a'").get()).toEqual({ n: 0 });

    outline.failing.delete("a");
    await runFullSync(outline.client);
    expect(chunkChars("a")).toBeGreaterThan(LONG.length * 0.8);
  });

  it("re-indexes documents that an older version indexed from truncated text", async () => {
    const docs: FakeDoc[] = [
      { id: "trunc", title: "T", text: LONG, revision: 3, updatedAt: "2026-11-01T10:00:00Z" },
      { id: "full", title: "F", text: LONG, revision: 3, updatedAt: "2026-11-01T10:00:00Z" },
    ];
    const outline = makeOutline(docs);
    await runFullSync(outline.client);

    // Simulate the legacy state: no hash/updatedAt, and "trunc" holding only a fragment.
    db.prepare("UPDATE index_state SET text_hash = NULL, doc_updated_at = NULL").run();
    db.prepare("DELETE FROM document_chunks WHERE doc_id = 'trunc' AND chunk_index > 0").run();
    embedCalls.length = 0;

    await runFullSync(outline.client);
    expect(chunkChars("trunc")).toBeGreaterThan(LONG.length * 0.8);
    // "full" was complete: verified once, not re-embedded.
    expect(embedCalls.flat().some((t) => t.startsWith("F"))).toBe(false);
    expect(embedCalls.flat().some((t) => t.startsWith("T"))).toBe(true);
  });
});

describe("index sync — pruning, forced rebuild, single document", () => {
  const docA = (): FakeDoc => ({ id: "a", title: "A", text: LONG, revision: 1, updatedAt: "2026-11-01T10:00:00Z" });
  const docB = (): FakeDoc => ({ id: "b", title: "B", text: LONG, revision: 1, updatedAt: "2026-11-01T10:00:00Z" });
  const indexed = () => (db.prepare("SELECT doc_id FROM index_state ORDER BY doc_id").all() as Array<{ doc_id: string }>).map((r) => r.doc_id);

  it("keeps a document missing from the listing unless Outline confirms it is gone", async () => {
    const docs = [docA(), docB()];
    const outline = makeOutline(docs);
    await runFullSync(outline.client);
    expect(indexed()).toEqual(["a", "b"]);

    // Missed by the paginated list but still readable → kept.
    outline.hiddenFromList.add("b");
    let stats = await runFullSync(outline.client);
    expect(stats.pruned).toBe(0);
    expect(indexed()).toEqual(["a", "b"]);

    // Outline unreachable for it → kept as well.
    outline.unreachable.add("b");
    stats = await runFullSync(outline.client);
    expect(indexed()).toEqual(["a", "b"]);

    // Really deleted (404) → dropped.
    outline.unreachable.delete("b");
    docs.splice(1, 1);
    stats = await runFullSync(outline.client);
    expect(stats.pruned).toBe(1);
    expect(indexed()).toEqual(["a"]);
  });

  it("reports failures and persists the last result", async () => {
    const outline = makeOutline([docA(), docB()]);
    outline.failing.add("b");
    const stats = await runFullSync(outline.client);
    expect(stats).toMatchObject({ seen: 2, indexed: 1, failed: 1, error: null });
    expect(stats.failures[0]).toMatchObject({ id: "b", title: "B" });
    expect(lastSyncResult()).toMatchObject({ indexed: 1, failed: 1 });
    expect(currentSyncProgress()).toBeNull();
  });

  it("force re-embeds unchanged documents", async () => {
    const outline = makeOutline([docA()]);
    await runFullSync(outline.client);
    embedCalls.length = 0;
    outline.infoCalls.length = 0;

    const stats = await runFullSync(outline.client, { force: true });
    expect(outline.infoCalls).toEqual(["a"]);
    expect(stats.indexed).toBe(1);
    expect(embedCalls.length).toBeGreaterThan(0);
  });

  it("indexes a single document on demand", async () => {
    const outline = makeOutline([docA()]);
    const { doc, chunks } = await indexSingleDocument(outline.client, "a");
    expect(doc.id).toBe("a");
    expect(chunks).toBeGreaterThan(1);
    expect(indexed()).toEqual(["a"]);
  });
});

describe("parseRetryAfter", () => {
  it("accepts seconds and HTTP dates", () => {
    expect(parseRetryAfter("30")).toBe(30_000);
    expect(parseRetryAfter(null)).toBeUndefined();
    const inTenSeconds = new Date(Date.now() + 10_000).toUTCString();
    expect(parseRetryAfter(inTenSeconds)).toBeGreaterThan(8_000);
  });
});
