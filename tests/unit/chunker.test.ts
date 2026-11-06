import { describe, it, expect } from "vitest";
import { chunkDocument, embeddingText } from "../../src/indexer/chunker.js";

describe("chunkDocument", () => {
  it("splits on every heading level and records the heading path", () => {
    const doc = [
      "Introduzione al modulo di gestione dati.",
      "# Sincronizzatore",
      "Il sincronizzatore allinea i dati tra i sistemi.",
      "## Servizi SOAP",
      "Gli endpoint SOAP espongono il WSDL su /ws/sync?wsdl.",
      "### Autenticazione",
      "Si usa WS-Security con username token.",
      "## Pianificazione",
      "La sincronizzazione parte ogni 15 minuti.",
      "# Import",
      "Import da file CSV.",
    ].join("\n");

    const chunks = chunkDocument(doc, "Gestione dati");
    expect(chunks.map((c) => c.heading)).toEqual([
      "Gestione dati",
      "Sincronizzatore",
      "Sincronizzatore › Servizi SOAP",
      "Sincronizzatore › Servizi SOAP › Autenticazione",
      "Sincronizzatore › Pianificazione",
      "Import",
    ]);
    expect(chunks.map((c) => c.chunkIndex)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("ignores headings inside fenced code blocks and keeps the block whole", () => {
    const doc = "## Config\nEsempio di configurazione:\n```\n# non è un titolo\nkey=value\n```\nFine sezione.";
    const chunks = chunkDocument(doc, "T");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.content).toContain("# non è un titolo");
  });

  it("splits long sections into bounded chunks on paragraph boundaries, with overlap", () => {
    const paras = Array.from({ length: 30 }, (_, i) => `Paragrafo ${i}: ${"testo descrittivo ".repeat(8).trim()}.`);
    const doc = `## Lunga\n${paras.join("\n\n")}`;
    const chunks = chunkDocument(doc, "T", { maxChars: 600, overlapChars: 120 });

    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) {
      expect(c.content.length).toBeLessThanOrEqual(600);
      expect(c.heading).toBe("Lunga");
    }
    // Every paragraph survives somewhere, and consecutive chunks share some text.
    for (let i = 0; i < 30; i++) expect(chunks.some((c) => c.content.includes(`Paragrafo ${i}:`))).toBe(true);
    const lastLineOfFirst = chunks[0]!.content.split("\n").at(-1)!;
    expect(chunks[1]!.content).toContain(lastLineOfFirst.slice(-40));
  });

  it("hard-splits a single huge paragraph", () => {
    const doc = `## Muro\n${"x".repeat(5000)}`;
    const chunks = chunkDocument(doc, "T", { maxChars: 1000, overlapChars: 0 });
    expect(chunks.length).toBe(5);
    expect(chunks.every((c) => c.content.length <= 1000)).toBe(true);
  });

  it("drops images and Outline hard-break backslashes, skips empty sections", () => {
    const doc = "## Vuota\n\n## Con immagine\n![schema](/api/attachments.redirect?id=1)\nTesto utile della sezione\\\nsu due righe.";
    const chunks = chunkDocument(doc, "T");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.content).toBe("Testo utile della sezione\nsu due righe.");
  });
});

describe("embeddingText", () => {
  it("prefixes title and heading path", () => {
    expect(embeddingText("Gestione dati", { heading: "Sincronizzatore › SOAP", content: "x" })).toBe(
      "Gestione dati › Sincronizzatore › SOAP\n\nx",
    );
    expect(embeddingText("Gestione dati", { heading: "Gestione dati", content: "x" })).toBe("Gestione dati\n\nx");
  });
});
