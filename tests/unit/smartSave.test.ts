import { describe, it, expect, vi, beforeEach } from "vitest";

// --- LLM: scripted responses -------------------------------------------------
const llmResponses: string[] = [];
const llmPrompts: string[] = [];
vi.mock("../../src/ai/client.js", () => ({
  callModel: vi.fn(async (opts: { userPrompt: string }) => {
    llmPrompts.push(opts.userPrompt);
    const text = llmResponses.shift();
    if (text === undefined) throw new Error("unexpected LLM call");
    return { text, usage: { input: 0, output: 0 } };
  }),
  noThinkHint: () => "",
  llmQueueDepth: () => ({ running: 0, pending: 0 }),
  llmDescription: () => "test",
}));

// --- Embeddings unavailable: placement must work from the collection trees ---
vi.mock("../../src/embedding/client.js", () => ({
  embed: vi.fn(async () => {
    throw new Error("ollama down");
  }),
  embedOne: vi.fn(async () => {
    throw new Error("ollama down");
  }),
}));

const { startSaveProposal, applyProposal, reviseProposal } = await import("../../src/core/smartSave.js");
const { linkCollection } = await import("../../src/db/repositories/channelCollections.js");
const { findProposalByTrigger, findProposalById } = await import("../../src/db/repositories/saveProposals.js");

// --- Fake Outline --------------------------------------------------------------
interface Doc {
  id: string;
  title: string;
  text: string;
  revision: number;
  collectionId: string;
  parentDocumentId: string | null;
  url: string;
  urlId: string;
}

function makeOutline() {
  const docs = new Map<string, Doc>();
  const calls: Array<{ endpoint: string; body: Record<string, unknown> }> = [];
  const add = (d: Omit<Doc, "url" | "urlId" | "revision">) =>
    docs.set(d.id, { ...d, revision: 1, urlId: `${d.id}-url`, url: `/doc/${d.id}` });

  add({ id: "doc-acme", title: "ACME", text: "Cliente ACME.\n", collectionId: "col-1", parentDocumentId: null });
  add({
    id: "doc-f1",
    title: "ACME — Fase 1",
    text: "## Stato\nIn corso.\n\n## Attività\n- analisi requisiti\n",
    collectionId: "col-1",
    parentDocumentId: "doc-acme",
  });

  const tree = () => {
    const node = (d: Doc): unknown => ({
      id: d.id,
      title: d.title,
      url: d.url,
      children: [...docs.values()].filter((c) => c.parentDocumentId === d.id).map(node),
    });
    return [...docs.values()].filter((d) => d.collectionId === "col-1" && !d.parentDocumentId).map(node);
  };

  const client = {
    async post(endpoint: string, body: Record<string, unknown>) {
      calls.push({ endpoint, body });
      switch (endpoint) {
        case "/collections.list":
          return [{ id: "col-1", name: "Clienti", urlId: "clienti1" }];
        case "/collections.documents":
          return tree();
        case "/documents.info": {
          const d = docs.get(String(body.id)) ?? [...docs.values()].find((x) => x.urlId === body.id);
          if (!d) throw Object.assign(new Error("not found"), { status: 404 });
          return { ...d };
        }
        case "/documents.update": {
          const d = docs.get(String(body.id))!;
          d.text = String(body.text);
          d.revision++;
          return { ...d };
        }
        case "/documents.create": {
          const id = `doc-new-${docs.size}`;
          add({
            id,
            title: String(body.title),
            text: String(body.text),
            collectionId: String(body.collectionId),
            parentDocumentId: (body.parentDocumentId as string | undefined) ?? null,
          });
          return { ...docs.get(id)! };
        }
        default:
          throw new Error(`unexpected Outline call ${endpoint}`);
      }
    },
  };
  return { client, docs, calls };
}

// --- Fake Mattermost -----------------------------------------------------------
function makeMattermost() {
  const posts = new Map<string, { id: string; message: string; root_id?: string }>();
  let n = 0;
  const client = {
    async getThread() {
      return {
        order: ["root", "r1", "trigger"],
        posts: {
          root: { id: "root", create_at: 1, user_id: "u-anna", channel_id: "ch1", root_id: "", message: "Fase 1 di ACME: il collaudo è stato completato oggi.", props: {} },
          r1: { id: "r1", create_at: 2, user_id: "u-luca", channel_id: "ch1", root_id: "root", message: "Il cliente ha firmato il verbale.", props: {} },
          trigger: { id: "trigger", create_at: 3, user_id: "u-anna", channel_id: "ch1", root_id: "root", message: "@kbtest salva", props: {} },
        },
      };
    },
    async getUsersByIds(ids: string[]) {
      return ids.map((id) => ({ id, username: id.replace("u-", "") }));
    },
    async createPost(p: { channel_id: string; message: string; root_id?: string }) {
      const post = { id: `bot-${++n}`, ...p };
      posts.set(post.id, post);
      return post;
    },
    async updatePost(id: string, message: string) {
      posts.get(id)!.message = message;
      return posts.get(id);
    },
    async getFileBlob() {
      throw new Error("no files");
    },
  };
  return { client, posts };
}

const logger = { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, child() { return this; } };

function trigger(id: string) {
  return { id, create_at: 3, update_at: 3, user_id: "u-anna", channel_id: "ch1", root_id: "root", message: "@kbtest salva", type: "", props: {} };
}

beforeEach(() => {
  llmResponses.length = 0;
  llmPrompts.length = 0;
});

linkCollection("ch1", "col-1", "Clienti", "u-admin");

describe("smart save (human-in-the-loop)", () => {
  it("proposes an update to the right document and applies it only after approval", async () => {
    const outline = makeOutline();
    const mm = makeMattermost();
    const ctx = { mmClient: mm.client as never, outlineClient: outline.client as never, logger: logger as never, botUserId: "bot" };

    llmResponses.push(
      // 1st placement answer uses a ref that doesn't exist → must be retried with feedback
      JSON.stringify({ action: "update", document: "D99", confidence: 0.9, reasoning: "x" }),
      JSON.stringify({ action: "update", document: "D2", confidence: 0.92, reasoning: "Riguarda la fase 1 di ACME" }),
      JSON.stringify({
        edits: [
          { op: "replace_section", heading: "Stato", content: "Completata." },
          { op: "append_to_section", heading: "Attività", content: "- collaudo completato, verbale firmato dal cliente" },
        ],
        change_summary: "Fase 1 chiusa: collaudo completato",
      }),
    );

    await startSaveProposal({ post: trigger("t-update") as never, hint: null, teamName: "team", ctx });

    expect(llmPrompts[1]).toContain("Your previous response was invalid");
    const proposal = findProposalByTrigger("t-update")!;
    expect(proposal.status).toBe("pending");
    const preview = mm.posts.get(proposal.bot_reply_post_id)!.message;
    expect(preview).toContain("Proposta di modifica");
    expect(preview).toContain("ACME — Fase 1");
    expect(preview).toContain("Clienti › ACME › ACME — Fase 1");
    // Nothing written yet.
    expect(outline.calls.some((c) => c.endpoint === "/documents.update")).toBe(false);

    await applyProposal({ proposal, actorUserId: "u-anna", actorUsername: "anna", ctx });

    const doc = outline.docs.get("doc-f1")!;
    expect(doc.text).toContain("## Stato\n\nCompletata.");
    expect(doc.text).toContain("- analisi requisiti\n\n- collaudo completato, verbale firmato dal cliente");
    expect(doc.text).toMatch(/## Storico aggiornamenti\n\n- \d{4}-\d{2}-\d{2} · @anna · Fase 1 chiusa: collaudo completato · \[thread Mattermost\]\(https:\/\/chat\.example\.com\/team\/pl\/root\)/);
    expect(findProposalById(proposal.id)!.status).toBe("applied");
    expect([...mm.posts.values()].some((p) => p.message.startsWith("✅ Aggiornato [ACME — Fase 1]"))).toBe(true);

    // A second approval (e.g. duplicate reaction) is a no-op.
    await applyProposal({ proposal, actorUserId: "u-anna", actorUsername: "anna", ctx });
    expect(outline.calls.filter((c) => c.endpoint === "/documents.update")).toHaveLength(1);
  });

  it("creates a new nested document, and can be redirected before approval", async () => {
    const outline = makeOutline();
    const mm = makeMattermost();
    const ctx = { mmClient: mm.client as never, outlineClient: outline.client as never, logger: logger as never, botUserId: "bot" };

    llmResponses.push(
      JSON.stringify({ action: "create", collection: "C1", parent_document: "D1", title: "ACME — Fase 2", confidence: 0.7, reasoning: "Nuova fase" }),
      JSON.stringify({ title: "ACME — Fase 2", text: "## Contesto\nAvvio fase 2.", change_summary: "Creata la fase 2" }),
    );
    await startSaveProposal({ post: trigger("t-create") as never, hint: "nuova fase", teamName: "team", ctx });
    let proposal = findProposalByTrigger("t-create")!;
    expect(mm.posts.get(proposal.bot_reply_post_id)!.message).toContain("creare il documento **ACME — Fase 2**");

    // The user renames it — no new LLM call needed.
    await reviseProposal({ proposal, change: { kind: "rename", title: "ACME — Fase 2 — Sviluppo" }, ctx });
    proposal = findProposalById(proposal.id)!;
    expect(proposal.status).toBe("pending");
    expect(mm.posts.get(proposal.bot_reply_post_id)!.message).toContain("ACME — Fase 2 — Sviluppo");

    await applyProposal({ proposal, actorUserId: "u-anna", actorUsername: "anna", ctx });
    const create = outline.calls.find((c) => c.endpoint === "/documents.create")!;
    expect(create.body).toMatchObject({ collectionId: "col-1", parentDocumentId: "doc-acme", title: "ACME — Fase 2 — Sviluppo" });
    expect(String(create.body.text)).toContain("## Contesto\nAvvio fase 2.");
    expect(String(create.body.text)).toContain("## Storico aggiornamenti");
  });

  it("refuses to target a document outside the linked collections", async () => {
    const outline = makeOutline();
    outline.docs.set("doc-other", {
      id: "doc-other", title: "Segreto", text: "x", revision: 1, collectionId: "col-private",
      parentDocumentId: null, url: "/doc/doc-other", urlId: "OtherDoc01",
    });
    const mm = makeMattermost();
    const ctx = { mmClient: mm.client as never, outlineClient: outline.client as never, logger: logger as never, botUserId: "bot" };

    llmResponses.push(
      JSON.stringify({ action: "update", document: "D2", confidence: 0.9, reasoning: "ok" }),
      JSON.stringify({ edits: [], change_summary: "niente di nuovo" }),
    );
    await startSaveProposal({ post: trigger("t-guard") as never, hint: null, teamName: "team", ctx });
    const proposal = findProposalByTrigger("t-guard")!;

    // An update with no edits can't be approved (it would only add a changelog line).
    await applyProposal({ proposal, actorUserId: "u-anna", actorUsername: "anna", ctx });
    expect(outline.calls.some((c) => c.endpoint === "/documents.update")).toBe(false);
    expect(findProposalById(proposal.id)!.status).toBe("pending");

    await reviseProposal({ proposal, change: { kind: "retarget_doc", ref: "OtherDoc01" }, ctx });
    expect([...mm.posts.values()].some((p) => p.message.includes("non è in una collection collegata"))).toBe(true);
    expect(findProposalById(proposal.id)!.status).toBe("pending");
  });
});
