import { describe, it, expect, vi, afterEach } from "vitest";

process.env.SEARCH_RERANK_PROVIDER = "api";
process.env.RERANK_BASE_URL = "https://rerank.example.com/api/v1";
process.env.RERANK_MODEL = "qwen/qwen3-reranker-8b";
process.env.RERANK_API_KEY = "sk-test";
process.env.RERANK_PROVIDER_PREFS = '{"zdr":true,"data_collection":"deny"}';
process.env.RERANK_MIN_SCORE = "0.3";

const { rerankPassages, rerankThreshold, rerankUrl, parseRerankResponse } = await import("../../src/search/rerank.js");

const passages = [
  { title: "AHRW – Gestione documenti", heading: "Causali documento", content: "Le causali documento definiscono numerazione e stampa." },
  { title: "Integrazione Traxal", heading: "AHRWTX_Docs", content: "Pubblica i documenti verso Traxal." },
];

afterEach(() => vi.unstubAllGlobals());

describe("reranker API", () => {
  it("sends a Cohere-style request and maps scores back to the passages", async () => {
    let sent: { url: string; init: RequestInit } | null = null;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      sent = { url, init };
      // Results come back sorted by relevance, not in input order.
      return new Response(JSON.stringify({ results: [{ index: 0, relevance_score: 0.91 }, { index: 1, relevance_score: 0.07 }] }));
    });

    const scores = await rerankPassages({
      query: "e per gli acquisti?",
      followUpOf: "come funzionano i documenti in AHRW?",
      glossaryNote: "AHRW = Ad hoc Revolution Web",
      passages,
    });
    expect(scores).toEqual([0.91, 0.07]);
    expect(rerankThreshold()).toBe(0.3);

    expect(sent!.url).toBe("https://rerank.example.com/api/v1/rerank");
    expect((sent!.init.headers as Record<string, string>)["Authorization"]).toBe("Bearer sk-test");
    const body = JSON.parse(String(sent!.init.body));
    expect(body).toMatchObject({
      model: "qwen/qwen3-reranker-8b",
      top_n: 2,
      provider: { zdr: true, data_collection: "deny" },
    });
    expect(body.query).toBe("come funzionano i documenti in AHRW? — e per gli acquisti? (AHRW = Ad hoc Revolution Web)");
    expect(body.documents[0]).toBe("AHRW – Gestione documenti › Causali documento\nLe causali documento definiscono numerazione e stampa.");
  });

  it("throws on HTTP errors so search falls back to the hybrid order", async () => {
    vi.stubGlobal("fetch", async () => new Response("no such model", { status: 404 }));
    await expect(rerankPassages({ query: "x", passages })).rejects.toThrow(/HTTP 404/);
  });

  it("accepts the common response shapes", () => {
    expect(parseRerankResponse([{ index: 1, score: 0.8 }, { index: 0, score: 0.1 }], 2)).toEqual([0.1, 0.8]); // TEI
    expect(parseRerankResponse({ data: [{ index: 0, relevance_score: 0.5 }] }, 2)).toEqual([0.5, 0]);
    expect(() => parseRerankResponse({ foo: 1 }, 2)).toThrow();
    expect(() => parseRerankResponse({ results: [{ index: 9, relevance_score: 1 }] }, 2)).toThrow();
  });

  it("builds the endpoint URL", () => {
    expect(rerankUrl("http://reranker:8080/v1/")).toBe("http://reranker:8080/v1/rerank");
    expect(rerankUrl("http://tei:80")).toBe("http://tei:80/rerank");
    expect(rerankUrl("https://x/v1/rerank")).toBe("https://x/v1/rerank");
  });
});
