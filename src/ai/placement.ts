import { z } from "zod";
import { callModelJson } from "./jsonCall.js";
import { noThinkHint } from "./client.js";

/**
 * Decides WHERE new knowledge from a Mattermost thread belongs in Outline:
 * update an existing document, or create a new one (in which collection,
 * under which parent). Documents and collections are presented to the model
 * with short refs (D12, C3) — small local models mangle UUIDs.
 */

export interface PlacementCollection {
  id: string;
  name: string;
  description?: string | null;
  /** Depth-first document tree of the collection. */
  docs: Array<{ id: string; title: string; depth: number }>;
}

export interface PlacementCandidate {
  docId: string;
  title: string;
  collectionId: string;
  score: number;
  headings: string[];
  snippet: string;
}

export interface PlacementInput {
  todayIso: string;
  hint: string | null;
  extraInstructions: string[];
  threadText: string;
  attachments: Array<{ filename: string; text: string }>;
  collections: PlacementCollection[];
  candidates: PlacementCandidate[];
}

export interface PlacementDecision {
  action: "update" | "create";
  documentId: string | null;
  collectionId: string;
  parentDocumentId: string | null;
  title: string;
  confidence: number;
  reasoning: string;
  alternatives: Array<{ label: string; reason: string }>;
}

const RefSchema = z.string().trim().nullish();

const PlacementSchema = z.object({
  action: z.enum(["update", "create"]),
  document: RefSchema,
  collection: RefSchema,
  parent_document: RefSchema,
  title: z.string().trim().nullish(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  alternatives: z
    .array(
      z.object({
        action: z.enum(["update", "create"]).catch("update"),
        document: RefSchema,
        collection: RefSchema,
        title: z.string().nullish(),
        reason: z.string().default(""),
      }),
    )
    .default([]),
});
type RawPlacement = z.infer<typeof PlacementSchema>;

const SYSTEM_PROMPT = `You are the librarian of a company knowledge base hosted on Outline.
Outline is organised in COLLECTIONS, each containing a TREE of DOCUMENTS (documents can be nested).
You receive a Mattermost discussion thread (plus optional attached files) containing new information,
the collections you are allowed to write to with their document trees, and the existing documents that
are most semantically similar to the thread.

Decide where the new information belongs:
- "update": an EXISTING document is the natural home for this information (same client, project,
  phase, procedure, system…). Strongly prefer updating over creating duplicates.
- "create": no existing document fits. Create a new document in the most logical collection and,
  when the tree has a fitting parent (e.g. the client's or project's page), nest it under that parent.
  Mirror the naming conventions you see in the tree (e.g. "ACME — Fase 2 — Collaudo").

Think about the entities involved (client, project, phase, product, team, process) and find the
document/collection that represents them. Follow the user's hint when one is given.

Respond with a single JSON object and nothing else:
{
  "action": "update" | "create",
  "document": "D<n>" | null,          // required for update
  "collection": "C<n>" | null,        // required for create
  "parent_document": "D<n>" | null,   // optional for create, must belong to "collection"
  "title": "string" | null,           // required for create: title of the new document
  "confidence": 0.0-1.0,              // >0.85 very sure, 0.6-0.85 plausible, <0.6 unsure
  "reasoning": "one or two short sentences, in the language of the thread",
  "alternatives": [ { "action": "update"|"create", "document": "D<n>"|null, "collection": "C<n>"|null, "title": "string"|null, "reason": "short" } ]
}
Use ONLY refs that appear in the input. Give up to 2 alternatives when the choice is not obvious.`;

const MAX_TREE_LINES = 350;
const MAX_THREAD_CHARS = 12_000;
const MAX_ATTACHMENT_CHARS = 3_000;

export class RefMap {
  private docByRef = new Map<string, { id: string; title: string; collectionId: string }>();
  private refByDoc = new Map<string, string>();
  private colByRef = new Map<string, { id: string; name: string }>();
  private refByCol = new Map<string, string>();

  docRef(id: string, title: string, collectionId: string): string {
    const existing = this.refByDoc.get(id);
    if (existing) return existing;
    const ref = `D${this.docByRef.size + 1}`;
    this.docByRef.set(ref, { id, title, collectionId });
    this.refByDoc.set(id, ref);
    return ref;
  }

  colRef(id: string, name: string): string {
    const existing = this.refByCol.get(id);
    if (existing) return existing;
    const ref = `C${this.colByRef.size + 1}`;
    this.colByRef.set(ref, { id, name });
    this.refByCol.set(id, ref);
    return ref;
  }

  doc(ref: string | null | undefined) {
    return ref ? this.docByRef.get(ref.trim().replace(/^\[|\]$/g, "").toUpperCase()) ?? null : null;
  }

  col(ref: string | null | undefined) {
    return ref ? this.colByRef.get(ref.trim().replace(/^\[|\]$/g, "").toUpperCase()) ?? null : null;
  }
}

function buildPrompt(input: PlacementInput, refs: RefMap): string {
  const lines: string[] = [];
  lines.push(`TODAY: ${input.todayIso}`);
  lines.push(`USER HINT: ${input.hint?.trim() || "(none)"}`);
  for (const ins of input.extraInstructions) lines.push(`USER INSTRUCTION: ${ins}`);
  lines.push("");

  lines.push("COLLECTIONS YOU CAN WRITE TO (with their document trees):");
  let treeLines = 0;
  for (const c of input.collections) {
    const cref = refs.colRef(c.id, c.name);
    const desc = c.description ? ` — ${c.description.replace(/\s+/g, " ").slice(0, 200)}` : "";
    lines.push(`[${cref}] ${c.name}${desc}`);
    if (c.docs.length === 0) lines.push("    (empty collection)");
    let shown = 0;
    for (const d of c.docs) {
      if (treeLines >= MAX_TREE_LINES) break;
      const dref = refs.docRef(d.id, d.title, c.id);
      lines.push(`${"    ".repeat(d.depth + 1)}[${dref}] ${d.title}`);
      treeLines++;
      shown++;
    }
    if (shown < c.docs.length) lines.push(`    … (${c.docs.length - shown} more documents not shown)`);
  }
  lines.push("");

  lines.push("MOST SIMILAR EXISTING DOCUMENTS (semantic search over the thread):");
  if (input.candidates.length === 0) lines.push("(none found)");
  for (const cand of input.candidates) {
    const dref = refs.docRef(cand.docId, cand.title, cand.collectionId);
    const cref = refs.colRef(cand.collectionId, input.collections.find((c) => c.id === cand.collectionId)?.name ?? "?");
    lines.push(`[${dref}] "${cand.title}" in [${cref}] — similarity ${cand.score.toFixed(2)}`);
    if (cand.headings.length > 0) lines.push(`    sections: ${cand.headings.slice(0, 15).join(" | ")}`);
    if (cand.snippet) lines.push(`    excerpt: ${cand.snippet.replace(/\s+/g, " ").slice(0, 400)}`);
  }
  lines.push("");

  lines.push("THREAD (chronological):");
  lines.push(input.threadText.slice(0, MAX_THREAD_CHARS));
  lines.push("");

  if (input.attachments.length > 0) {
    lines.push("ATTACHED FILES (extracted text, truncated):");
    for (const a of input.attachments) {
      lines.push(`### ${a.filename}`);
      lines.push(a.text.slice(0, MAX_ATTACHMENT_CHARS));
      lines.push("");
    }
  }

  lines.push("Decide where this information belongs.");
  const hint = noThinkHint();
  if (hint) lines.push(hint);
  return lines.join("\n");
}

function validate(raw: RawPlacement, refs: RefMap, collectionIds: Set<string>): string | null {
  if (raw.action === "update") {
    const doc = refs.doc(raw.document);
    if (!doc) return `"document" must be one of the D<n> refs listed in the input (got ${JSON.stringify(raw.document)})`;
    if (!collectionIds.has(doc.collectionId)) return `document ${raw.document} is not in a writable collection`;
    return null;
  }
  const col = refs.col(raw.collection);
  if (!col || !collectionIds.has(col.id)) {
    return `"collection" must be one of the C<n> refs listed in the input (got ${JSON.stringify(raw.collection)})`;
  }
  if (!raw.title) return `"title" is required when action is "create"`;
  if (raw.parent_document) {
    const parent = refs.doc(raw.parent_document);
    if (!parent) return `"parent_document" ${JSON.stringify(raw.parent_document)} is not a listed D<n> ref`;
    if (parent.collectionId !== col.id) return `"parent_document" must belong to collection ${raw.collection}`;
  }
  return null;
}

export async function planPlacement(input: PlacementInput): Promise<PlacementDecision> {
  if (input.collections.length === 0) throw new Error("no writable collections");
  const refs = new RefMap();
  const userPrompt = buildPrompt(input, refs);
  const collectionIds = new Set(input.collections.map((c) => c.id));

  const raw = await callModelJson({
    name: "placement",
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    schema: PlacementSchema,
    maxTokens: 4000,
    temperature: 0.2,
    validate: (v) => validate(v, refs, collectionIds),
  });

  const alternatives = raw.alternatives.slice(0, 2).map((a) => {
    const doc = refs.doc(a.document);
    const col = refs.col(a.collection);
    const label =
      a.action === "update" && doc
        ? `aggiornare «${doc.title}»`
        : `creare «${a.title ?? "nuovo documento"}»${col ? ` in ${col.name}` : ""}`;
    return { label, reason: a.reason };
  });

  if (raw.action === "update") {
    const doc = refs.doc(raw.document)!;
    return {
      action: "update",
      documentId: doc.id,
      collectionId: doc.collectionId,
      parentDocumentId: null,
      title: doc.title,
      confidence: raw.confidence,
      reasoning: raw.reasoning,
      alternatives,
    };
  }

  const col = refs.col(raw.collection)!;
  const parent = refs.doc(raw.parent_document);
  return {
    action: "create",
    documentId: null,
    collectionId: col.id,
    parentDocumentId: parent?.id ?? null,
    title: raw.title!,
    confidence: raw.confidence,
    reasoning: raw.reasoning,
    alternatives,
  };
}
