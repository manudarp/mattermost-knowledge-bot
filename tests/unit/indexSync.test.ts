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

const { runFullSync, ensureIndexMatchesEmbeddingModel } = await import("../../src/indexer/outlineIndexer.js");
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
  const client = {
    async post(endpoint: string, body: Record<string, unknown>) {
      if (endpoint === "/documents.list") {
        if ((body.offset as number) > 0) return [];
        // The list only carries a truncated text, like Outline's.
        return docs.map((d) => ({ ...d, text: d.text.slice(0, 50), url: `/doc/${d.id}`, collectionId: "col" }));
      }
      if (endpoint === "/documents.info") {
        const id = String(body.id);
        infoCalls.push(id);
        if (failing.has(id)) throw new HttpError(429, "rate_limit_exceeded", "HTTP 429 POST /documents.info");
        const d = docs.find((x) => x.id === id)!;
        return { ...d, url: `/doc/${d.id}`, collectionId: "col" };
      }
      throw new Error(`unexpected ${endpoint}`);
    },
  };
  return { client: client as never, infoCalls, failing };
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

describe("parseRetryAfter", () => {
  it("accepts seconds and HTTP dates", () => {
    expect(parseRetryAfter("30")).toBe(30_000);
    expect(parseRetryAfter(null)).toBeUndefined();
    const inTenSeconds = new Date(Date.now() + 10_000).toUTCString();
    expect(parseRetryAfter(inTenSeconds)).toBeGreaterThan(8_000);
  });
});
