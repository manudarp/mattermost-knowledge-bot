import { describe, it, expect } from "vitest";
import { resolveCollectionRef, flattenTree, type OutlineCollection } from "../../src/outline/collections.js";
import { documentRefFromText, documentUrl } from "../../src/outline/documents.js";
import { chatCompletionsUrl } from "../../src/ai/client.js";

const COLLECTIONS: OutlineCollection[] = [
  { id: "11111111-1111-1111-1111-111111111111", name: "Clienti", urlId: "AbCdEf1234" },
  { id: "22222222-2222-2222-2222-222222222222", name: "Clienti Archivio", urlId: "ZzZzZz9999" },
  { id: "33333333-3333-3333-3333-333333333333", name: "Procedure interne", urlId: "PpPpPp0000" },
];

describe("resolveCollectionRef", () => {
  it("exact name wins over partial matches", () => {
    expect(resolveCollectionRef("clienti", COLLECTIONS)).toEqual({ match: COLLECTIONS[0] });
  });

  it("unique partial match", () => {
    expect(resolveCollectionRef("procedure", COLLECTIONS)).toEqual({ match: COLLECTIONS[2] });
  });

  it("ambiguous partial match", () => {
    const r = resolveCollectionRef("clien", COLLECTIONS);
    expect("ambiguous" in r && r.ambiguous.length).toBe(2);
  });

  it("by UUID, urlId and URL", () => {
    expect(resolveCollectionRef("33333333-3333-3333-3333-333333333333", COLLECTIONS)).toEqual({ match: COLLECTIONS[2] });
    expect(resolveCollectionRef("ZzZzZz9999", COLLECTIONS)).toEqual({ match: COLLECTIONS[1] });
    expect(resolveCollectionRef("https://wiki.example.com/collection/clienti-AbCdEf1234", COLLECTIONS)).toEqual({
      match: COLLECTIONS[0],
    });
  });

  it("not found", () => {
    expect(resolveCollectionRef("marketing", COLLECTIONS)).toEqual({ none: true });
  });
});

describe("flattenTree", () => {
  it("returns depth-first entries with paths", () => {
    const flat = flattenTree([
      { id: "a", title: "ACME", url: "/doc/a", children: [{ id: "b", title: "Fase 1", url: "/doc/b", children: [] }] },
      { id: "c", title: "Globex", url: "/doc/c", children: [] },
    ]);
    expect(flat.map((f) => [f.id, f.depth, f.path.join(" › ")])).toEqual([
      ["a", 0, "ACME"],
      ["b", 1, "ACME › Fase 1"],
      ["c", 0, "Globex"],
    ]);
  });
});

describe("documentRefFromText", () => {
  it("extracts the urlId from document URLs and paths", () => {
    expect(documentRefFromText("https://wiki.example.com/doc/acme-fase-2-Xy12AbCd34")).toBe("Xy12AbCd34");
    expect(documentRefFromText("<https://wiki.example.com/doc/acme-Xy12AbCd34#heading>")).toBe("Xy12AbCd34");
    expect(documentRefFromText("/doc/acme-Xy12AbCd34")).toBe("Xy12AbCd34");
  });

  it("accepts UUIDs and bare urlIds, rejects titles", () => {
    expect(documentRefFromText("11111111-1111-1111-1111-111111111111")).toBe("11111111-1111-1111-1111-111111111111");
    expect(documentRefFromText("Xy12AbCd34")).toBe("Xy12AbCd34");
    expect(documentRefFromText("ACME Fase 2")).toBeNull();
  });
});

describe("documentUrl", () => {
  it("makes Outline's relative url absolute", () => {
    expect(documentUrl("https://wiki.example.com/", { id: "x", url: "/doc/a-1" })).toBe("https://wiki.example.com/doc/a-1");
    expect(documentUrl("https://wiki.example.com", { id: "x", urlId: "u1" })).toBe("https://wiki.example.com/doc/u1");
  });
});

describe("chatCompletionsUrl", () => {
  it("handles local servers and versioned provider bases", () => {
    expect(chatCompletionsUrl("http://localhost:8020")).toBe("http://localhost:8020/v1/chat/completions");
    expect(chatCompletionsUrl("http://localhost:8020/")).toBe("http://localhost:8020/v1/chat/completions");
    expect(chatCompletionsUrl("https://openrouter.ai/api/v1")).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(chatCompletionsUrl("https://api.openai.com/v1/")).toBe("https://api.openai.com/v1/chat/completions");
    expect(chatCompletionsUrl("https://x.example/v1/chat/completions")).toBe("https://x.example/v1/chat/completions");
  });
});
