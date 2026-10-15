import { describe, it, expect } from "vitest";
import { applyEdit, applyEdits, EditError, listHeadings } from "../../src/core/markdownSections.js";

const DOC = `Intro paragraph.

## Stato
In corso.

## Fase 1
Analisi completata.

### Dettagli
- punto A

## Fase 2
Da iniziare.

\`\`\`
## not a heading (code)
\`\`\`

## Storico aggiornamenti
- 2026-01-01 · creato
`;

describe("listHeadings", () => {
  it("ignores headings inside fenced code", () => {
    expect(listHeadings(DOC).map((h) => h.text)).toEqual([
      "Stato",
      "Fase 1",
      "Dettagli",
      "Fase 2",
      "Storico aggiornamenti",
    ]);
  });
});

describe("applyEdit", () => {
  it("append_to_section adds after sub-sections and keeps everything else", () => {
    const out = applyEdit(DOC, { op: "append_to_section", heading: "Fase 1", content: "Kick-off fatto il 2026-02-01." });
    expect(out).toContain("### Dettagli\n- punto A\n\nKick-off fatto il 2026-02-01.\n\n## Fase 2");
    expect(out).toContain("Intro paragraph.");
    expect(out).toContain("## not a heading (code)");
  });

  it("replace_section replaces only the direct body, keeping sub-sections", () => {
    const out = applyEdit(DOC, { op: "replace_section", heading: "fase 1", content: "Analisi e design completati." });
    expect(out).toContain("## Fase 1\n\nAnalisi e design completati.\n\n### Dettagli\n- punto A");
    expect(out).not.toContain("Analisi completata.");
  });

  it("add_section after a given heading goes after its sub-sections", () => {
    const out = applyEdit(DOC, { op: "add_section", heading: "Fase 1b", content: "Extra.", after_heading: "Fase 1" });
    expect(out).toMatch(/- punto A\n\n## Fase 1b\n\nExtra\.\n\n## Fase 2/);
  });

  it("add_section without after_heading goes at the end, or before keepLastHeading", () => {
    const end = applyEdit(DOC, { op: "add_section", heading: "Note", content: "x" });
    expect(end.trimEnd().endsWith("## Note\n\nx")).toBe(true);

    const beforeLog = applyEdit(DOC, { op: "add_section", heading: "Note", content: "x" }, { keepLastHeading: "Storico aggiornamenti" });
    expect(beforeLog).toMatch(/## Note\n\nx\n\n## Storico aggiornamenti/);
  });

  it("add_section on an existing heading appends instead of duplicating", () => {
    const out = applyEdit(DOC, { op: "add_section", heading: "Storico aggiornamenti", content: "- 2026-02-02 · aggiornato" });
    expect(out.match(/## Storico aggiornamenti/g)).toHaveLength(1);
    expect(out.trimEnd().endsWith("- 2026-01-01 · creato\n\n- 2026-02-02 · aggiornato")).toBe(true);
  });

  it("strips a repeated heading at the top of the content", () => {
    const out = applyEdit(DOC, { op: "append_to_section", heading: "Stato", content: "## Stato\nCompletato." });
    expect(out.match(/## Stato/g)).toHaveLength(1);
    expect(out).toContain("In corso.\n\nCompletato.");
  });

  it("unknown heading throws EditError listing the available headings", () => {
    expect(() => applyEdit(DOC, { op: "replace_section", heading: "Fase 9", content: "x" })).toThrow(EditError);
    expect(() => applyEdit(DOC, { op: "replace_section", heading: "Fase 9", content: "x" })).toThrow(/available headings/);
  });

  it("ambiguous loose match is rejected", () => {
    // "fase" loosely matches both "Fase 1" and "Fase 2"
    expect(() => applyEdit(DOC, { op: "append_to_section", heading: "Fase", content: "x" })).toThrow(EditError);
  });

  it("works on a document without headings", () => {
    const out = applyEdit("Solo testo.\n", { op: "add_section", heading: "Decisioni", content: "- usare Postgres" });
    expect(out).toBe("Solo testo.\n\n## Decisioni\n\n- usare Postgres\n");
  });

  it("normalises CRLF input", () => {
    const out = applyEdit("## A\r\nuno\r\n", { op: "append_to_section", heading: "A", content: "due" });
    expect(out).toBe("## A\nuno\n\ndue\n");
  });
});

describe("applyEdits", () => {
  it("applies in order and names the failing edit", () => {
    expect(() =>
      applyEdits(DOC, [
        { op: "append_to_section", heading: "Stato", content: "ok" },
        { op: "append_to_section", heading: "Inesistente", content: "x" },
      ]),
    ).toThrow(/edit #2 \(append_to_section\)/);
  });
});
