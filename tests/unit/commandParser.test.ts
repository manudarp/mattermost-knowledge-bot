import { describe, it, expect } from "vitest";
import { parseCommand, parseCollectionArgs, parseProposalReply } from "../../src/core/commandParser.js";

describe("parseCommand", () => {
  it("empty string → unknown", () => {
    expect(parseCommand("").subcommand).toBe("unknown");
    expect(parseCommand("   ").subcommand).toBe("unknown");
  });

  it("help / aiuto (case insensitive)", () => {
    expect(parseCommand("help").subcommand).toBe("help");
    expect(parseCommand("HELP").subcommand).toBe("help");
    expect(parseCommand("aiuto").subcommand).toBe("help");
  });

  it("status / stato", () => {
    expect(parseCommand("status").subcommand).toBe("status");
    expect(parseCommand("stato").subcommand).toBe("status");
  });

  it("salva → save with empty args", () => {
    const r = parseCommand("salva");
    expect(r.subcommand).toBe("save");
    expect(r.args).toBe("");
  });

  it("SALVA / save aliases", () => {
    expect(parseCommand("SALVA").subcommand).toBe("save");
    expect(parseCommand("save").subcommand).toBe("save");
  });

  it("salva <hint> → hint in args without the keyword", () => {
    const r = parseCommand("salva aggiorna la fase 2 del progetto ACME");
    expect(r.subcommand).toBe("save");
    expect(r.args).toBe("aggiorna la fase 2 del progetto ACME");
  });

  it("cerca <q> → search with query", () => {
    const r = parseCommand("cerca come configuro il deploy");
    expect(r.subcommand).toBe("search");
    expect(r.searchQuery).toBe("come configuro il deploy");
  });

  it("search \"quoted\" → quotes stripped", () => {
    const r = parseCommand('search "quoted query"');
    expect(r.subcommand).toBe("search");
    expect(r.searchQuery).toBe("quoted query");
  });

  it("chiedi / ask / domanda: → general question", () => {
    expect(parseCommand("chiedi cos'è un monad?").subcommand).toBe("ask");
    expect(parseCommand("ask what is a monad").searchQuery).toBe("what is a monad");
    const r = parseCommand("domanda: quanto fa 2+2");
    expect(r.subcommand).toBe("ask");
    expect(r.searchQuery).toBe("quanto fa 2+2");
  });

  it("free text → question with the whole text as query", () => {
    const r = parseCommand("che mi dici delle leghe?");
    expect(r.subcommand).toBe("question");
    expect(r.searchQuery).toBe("che mi dici delle leghe?");
  });

  it("a lone hashtag is a question, not a save", () => {
    expect(parseCommand("#client-onboarding").subcommand).toBe("question");
  });

  it("collezioni / collections with args", () => {
    const r = parseCommand("collezioni aggiungi Clienti");
    expect(r.subcommand).toBe("collections");
    expect(r.args).toBe("aggiungi Clienti");
    expect(parseCommand("collections").subcommand).toBe("collections");
  });
});

describe("parseCollectionArgs", () => {
  it("empty / lista → list", () => {
    expect(parseCollectionArgs("")).toEqual({ action: "list" });
    expect(parseCollectionArgs("lista")).toEqual({ action: "list" });
  });

  it("disponibili → available", () => {
    expect(parseCollectionArgs("disponibili")).toEqual({ action: "available" });
  });

  it("aggiungi with comma-separated names containing spaces", () => {
    expect(parseCollectionArgs("aggiungi Clienti Italia, Progetti 2026")).toEqual({
      action: "add",
      global: false,
      refs: ["Clienti Italia", "Progetti 2026"],
    });
  });

  it("aggiungi globale", () => {
    expect(parseCollectionArgs("aggiungi globale Procedure")).toEqual({
      action: "add",
      global: true,
      refs: ["Procedure"],
    });
  });

  it("rimuovi with quotes", () => {
    expect(parseCollectionArgs('rimuovi "Vecchia wiki"')).toEqual({
      action: "remove",
      global: false,
      refs: ["Vecchia wiki"],
    });
  });

  it("crea <nome>", () => {
    expect(parseCollectionArgs("crea Nuovi clienti")).toEqual({ action: "create", name: "Nuovi clienti" });
  });

  it("missing refs / unknown action → invalid", () => {
    expect(parseCollectionArgs("aggiungi").action).toBe("invalid");
    expect(parseCollectionArgs("boh qualcosa").action).toBe("invalid");
  });
});

describe("parseProposalReply", () => {
  it("approval words only when they are the whole message", () => {
    expect(parseProposalReply("ok")).toEqual({ kind: "approve" });
    expect(parseProposalReply("Conferma!")).toEqual({ kind: "approve" });
    expect(parseProposalReply("sì")).toEqual({ kind: "approve" });
    expect(parseProposalReply("ok ma prima controlla il budget")).toBeNull();
  });

  it("cancel words only when they are the whole message", () => {
    expect(parseProposalReply("annulla")).toEqual({ kind: "cancel" });
    expect(parseProposalReply("no")).toEqual({ kind: "cancel" });
    expect(parseProposalReply("no, secondo me va bene così")).toBeNull();
  });

  it("keyword: value forms", () => {
    expect(parseProposalReply("doc: https://wiki.example.com/doc/fase-2-AbC123xyZ9")).toEqual({
      kind: "retarget_doc",
      ref: "https://wiki.example.com/doc/fase-2-AbC123xyZ9",
    });
    expect(parseProposalReply("collezione: Clienti")).toEqual({ kind: "retarget_collection", ref: "Clienti" });
    expect(parseProposalReply("sotto: ACME")).toEqual({ kind: "retarget_parent", ref: "ACME" });
    expect(parseProposalReply('titolo: "ACME — Fase 3"')).toEqual({ kind: "rename", title: "ACME — Fase 3" });
    expect(parseProposalReply("nota: aggiungi anche le date")).toEqual({ kind: "instructions", text: "aggiungi anche le date" });
  });

  it("ordinary messages are ignored", () => {
    expect(parseProposalReply("ciao a tutti")).toBeNull();
    expect(parseProposalReply("riunione: domani")).toBeNull();
  });
});
