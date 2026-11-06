import { z } from "zod";
import { callModelJson } from "./jsonCall.js";
import { noThinkHint } from "./client.js";
import { applyEdits, EditError, listHeadings, type EditOp } from "../core/markdownSections.js";

interface CommonInput {
  todayIso: string;
  hint: string | null;
  extraInstructions: string[];
  threadText: string;
  attachments: Array<{ filename: string; text: string }>;
}

const MAX_THREAD_CHARS = 20_000;
const MAX_ATTACHMENTS_CHARS = 20_000;
const MAX_DOC_CHARS = 40_000;

const COMMON_RULES = `Rules:
- Write in the language of the existing document; for new documents, in the language of the thread.
- Be factual and concise. Never invent details that are not in the thread or the attached files.
- Attached files are authoritative source material: extract their substance, don't just link them.
- Use Markdown: "##"/"###" headings, bullet lists, tables when useful, fenced code blocks for code/config.
- Dates: use ISO format (YYYY-MM-DD); use TODAY when a decision/event date is not stated.
- Do not include a link to the Mattermost thread nor a changelog: the bot adds an audit entry itself.
- "change_summary": one sentence describing what you changed, in the language of the thread.`;

function renderSources(input: CommonInput): string {
  const lines: string[] = [];
  lines.push(`TODAY: ${input.todayIso}`);
  lines.push(`USER HINT: ${input.hint?.trim() || "(none)"}`);
  for (const ins of input.extraInstructions) lines.push(`USER INSTRUCTION (must be followed): ${ins}`);
  lines.push("");
  lines.push("THREAD (chronological):");
  lines.push(input.threadText.slice(0, MAX_THREAD_CHARS));
  lines.push("");
  if (input.attachments.length > 0) {
    lines.push("ATTACHED FILES (extracted text):");
    let budget = MAX_ATTACHMENTS_CHARS;
    for (const a of input.attachments) {
      const text = a.text.slice(0, Math.max(0, budget));
      budget -= text.length;
      lines.push(`### ${a.filename}`);
      lines.push(text || "[omitted: size budget exhausted]");
      lines.push("");
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// New document
// ---------------------------------------------------------------------------

export interface NewDocumentInput extends CommonInput {
  title: string;
  collectionName: string;
  parentPath: string[];
  /** Titles of sibling documents, to mirror structure/naming. */
  siblingTitles: string[];
}

export interface NewDocumentDraft {
  title: string;
  text: string;
  changeSummary: string;
}

const NewDocSchema = z.object({
  title: z.string().trim().min(1).max(200),
  text: z.string().trim().min(1),
  change_summary: z.string(),
});

const NEW_DOC_SYSTEM = `You are a technical writer maintaining a company knowledge base on Outline.
Write a NEW, well-structured document that captures the knowledge contained in a Mattermost
discussion thread (and its attached files).

Respond with a single JSON object and nothing else:
{ "title": "string", "text": "markdown body", "change_summary": "string" }

- "text" is the document BODY: do NOT repeat the title as a "# " heading at the top.
- Organise the body with "##" sections that fit the content (e.g. Contesto, Attività svolte,
  Decisioni, Dettagli tecnici, Prossimi passi, Riferimenti) — omit sections with nothing to say.
${COMMON_RULES}`;

export async function draftNewDocument(input: NewDocumentInput): Promise<NewDocumentDraft> {
  const lines: string[] = [];
  lines.push(`PROPOSED TITLE: ${input.title}`);
  lines.push(`COLLECTION: ${input.collectionName}`);
  lines.push(`PARENT DOCUMENT: ${input.parentPath.length > 0 ? input.parentPath.join(" › ") : "(top level)"}`);
  if (input.siblingTitles.length > 0) {
    lines.push(`SIBLING DOCUMENTS (mirror their naming): ${input.siblingTitles.slice(0, 30).join(" | ")}`);
  }
  lines.push("");
  lines.push(renderSources(input));
  lines.push("Write the new document.");
  const hint = noThinkHint();
  if (hint) lines.push(hint);

  const raw = await callModelJson({
    name: "draft_new_document",
    systemPrompt: NEW_DOC_SYSTEM,
    userPrompt: lines.join("\n"),
    schema: NewDocSchema,
    maxTokens: 8000,
    temperature: 0.3,
  });

  // Strip a leading H1 equal to the title, should the model add it anyway.
  const text = raw.text.replace(/^#\s+[^\n]*\n+/, (m) =>
    m.replace(/^#\s+/, "").trim().toLowerCase() === raw.title.toLowerCase() ? "" : m,
  );
  return { title: raw.title, text, changeSummary: raw.change_summary };
}

// ---------------------------------------------------------------------------
// Update existing document
// ---------------------------------------------------------------------------

export interface UpdateDocumentInput extends CommonInput {
  documentTitle: string;
  documentPath: string[];
  currentText: string;
  /** Heading the bot appends audit entries to; the model must not touch it. */
  changelogHeading: string;
}

export interface UpdateDraft {
  edits: EditOp[];
  changeSummary: string;
}

const EditOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("append_to_section"), heading: z.string().min(1), content: z.string().min(1) }),
  z.object({ op: z.literal("replace_section"), heading: z.string().min(1), content: z.string() }),
  z.object({
    op: z.literal("add_section"),
    heading: z.string().min(1),
    content: z.string().min(1),
    level: z.number().int().min(1).max(6).nullish(),
    after_heading: z.string().nullish(),
  }),
]);

const UpdateSchema = z.object({
  edits: z.array(EditOpSchema).max(12),
  change_summary: z.string(),
});

const UPDATE_SYSTEM = `You are a technical writer maintaining a company knowledge base on Outline.
You receive an EXISTING document and a Mattermost thread with new information. Integrate the new
information into the document with the SMALLEST set of section-level edits. You never rewrite the
whole document: everything you don't touch is preserved exactly.

Respond with a single JSON object and nothing else:
{
  "edits": [
    { "op": "append_to_section", "heading": "existing heading text", "content": "markdown to add at the end of that section" },
    { "op": "replace_section",   "heading": "existing heading text", "content": "new markdown body of that section (sub-sections are kept)" },
    { "op": "add_section",       "heading": "New heading text", "content": "markdown body", "level": 2, "after_heading": "existing heading text or null for end of document" }
  ],
  "change_summary": "string"
}

- "heading" must match one of the EXISTING HEADINGS listed in the input exactly (without the #).
- Prefer "append_to_section" and "add_section". Use "replace_section" only when existing content is
  now wrong or outdated (e.g. a status that changed), and keep everything in it that is still valid.
- Match the tone, structure and formatting conventions of the existing document.
- Don't duplicate information that is already present. If the thread adds nothing new, return "edits": [].
- Never edit the section named in CHANGELOG HEADING.
${COMMON_RULES}`;

export async function draftDocumentUpdate(input: UpdateDocumentInput): Promise<UpdateDraft> {
  const headings = listHeadings(input.currentText);
  const truncated = input.currentText.length > MAX_DOC_CHARS;

  const lines: string[] = [];
  lines.push(`DOCUMENT: ${input.documentPath.join(" › ") || input.documentTitle}`);
  lines.push(`CHANGELOG HEADING (do not edit): ${input.changelogHeading || "(none)"}`);
  lines.push("EXISTING HEADINGS:");
  if (headings.length === 0) lines.push("(none — use add_section)");
  for (const h of headings) lines.push(`${"  ".repeat(h.level - 1)}- ${h.text}`);
  lines.push("");
  lines.push(`CURRENT DOCUMENT CONTENT${truncated ? " (truncated)" : ""}:`);
  lines.push("<<<DOCUMENT");
  lines.push(input.currentText.slice(0, MAX_DOC_CHARS));
  lines.push("DOCUMENT>>>");
  lines.push("");
  lines.push(renderSources(input));
  lines.push("Produce the edits.");
  const hint = noThinkHint();
  if (hint) lines.push(hint);

  const changelogNorm = input.changelogHeading.trim().toLowerCase();

  const raw = await callModelJson({
    name: "draft_document_update",
    systemPrompt: UPDATE_SYSTEM,
    userPrompt: lines.join("\n"),
    schema: UpdateSchema,
    maxTokens: 8000,
    temperature: 0.3,
    // Dry-run the edits: any heading mismatch goes back to the model as feedback.
    validate: (v) => {
      if (changelogNorm && v.edits.some((e) => e.heading.trim().toLowerCase() === changelogNorm)) {
        return `edits must not target the changelog section "${input.changelogHeading}"`;
      }
      try {
        applyEdits(input.currentText, v.edits as EditOp[]);
        return null;
      } catch (err) {
        if (err instanceof EditError) return err.message;
        throw err;
      }
    },
  });

  return { edits: raw.edits as EditOp[], changeSummary: raw.change_summary };
}
