/**
 * Section-level editing of Markdown documents.
 *
 * The bot never rewrites a whole existing document: the LLM proposes a list of
 * operations addressed by heading, and they are applied here deterministically.
 * Everything not targeted by an operation is preserved byte-for-byte, and the
 * same operations can be re-applied onto a newer revision of the document if a
 * human edited it while the proposal was awaiting approval.
 */

export type EditOp =
  /** Add content at the end of a section (after its sub-sections). */
  | { op: "append_to_section"; heading: string; content: string }
  /** Replace the section's own body (text up to the first sub-heading). Sub-sections are kept. */
  | { op: "replace_section"; heading: string; content: string }
  /** Insert a new section after `after_heading`'s section, or at the end of the document. */
  | { op: "add_section"; heading: string; content: string; level?: number | null; after_heading?: string | null };

export class EditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditError";
  }
}

export interface Heading {
  line: number;
  level: number;
  text: string;
  norm: string;
}

const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE_RE = /^\s*(```|~~~)/;

export function normalizeHeading(text: string): string {
  return text
    .replace(/^#+\s*/, "")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function parseHeadings(lines: string[]): Heading[] {
  const out: Heading[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = HEADING_RE.exec(line);
    if (m) {
      const text = (m[2] ?? "").trim();
      out.push({ line: i, level: m[1]!.length, text, norm: normalizeHeading(text) });
    }
  }
  return out;
}

export function listHeadings(markdown: string): Array<{ level: number; text: string }> {
  return parseHeadings(toLines(markdown)).map((h) => ({ level: h.level, text: h.text }));
}

function toLines(markdown: string): string[] {
  return markdown.replace(/\r\n/g, "\n").split("\n");
}

function findHeading(headings: Heading[], ref: string): Heading | null {
  const norm = normalizeHeading(ref);
  if (!norm) return null;
  const exact = headings.find((h) => h.norm === norm);
  if (exact) return exact;
  // Tolerate small variations ("Fase 2" vs "Fase 2 — Sviluppo") only when unambiguous.
  const loose = headings.filter((h) => h.norm.includes(norm) || norm.includes(h.norm));
  return loose.length === 1 ? loose[0]! : null;
}

/** Index of the first line after the section, sub-sections included. */
function sectionEnd(lines: string[], headings: Heading[], h: Heading): number {
  const next = headings.find((o) => o.line > h.line && o.level <= h.level);
  return next ? next.line : lines.length;
}

/** Index of the first line after the section's own body (stops at any heading). */
function bodyEnd(lines: string[], headings: Heading[], h: Heading): number {
  const next = headings.find((o) => o.line > h.line);
  return next ? next.line : lines.length;
}

function contentLines(content: string, headingNorm?: string): string[] {
  const lines = toLines(content.trim());
  // Models sometimes repeat the target heading at the top of the content.
  if (headingNorm && lines.length > 0) {
    const m = HEADING_RE.exec(lines[0]!);
    if (m && normalizeHeading(m[2] ?? "") === headingNorm) {
      lines.shift();
      while (lines.length > 0 && lines[0]!.trim() === "") lines.shift();
    }
  }
  return lines;
}

/** Splices `insert` at `at`, collapsing blank lines around the seam. */
function spliceBlock(lines: string[], from: number, to: number, insert: string[]): string[] {
  let start = from;
  while (start > 0 && lines[start - 1]!.trim() === "") start--;
  let end = to;
  while (end < lines.length && lines[end]!.trim() === "") end++;
  const before = lines.slice(0, start);
  const after = lines.slice(end);
  const block = insert.length > 0 ? ["", ...insert] : [];
  return [...before, ...block, ...(after.length > 0 ? ["", ...after] : [""])];
}

function headingsHint(headings: Heading[]): string {
  if (headings.length === 0) return "the document has no headings";
  return "available headings: " + headings.map((h) => `"${h.text}"`).join(", ");
}

export interface ApplyOptions {
  /** End-of-document insertions go before this heading (e.g. the changelog) when it exists. */
  keepLastHeading?: string;
}

export function applyEdit(markdown: string, op: EditOp, opts: ApplyOptions = {}): string {
  let lines = toLines(markdown);
  const headings = parseHeadings(lines);

  if (op.op === "add_section") {
    const existing = findHeading(headings, op.heading);
    if (existing && normalizeHeading(op.heading) === existing.norm) {
      return applyEdit(markdown, { op: "append_to_section", heading: op.heading, content: op.content }, opts);
    }
    const after = op.after_heading ? findHeading(headings, op.after_heading) : null;
    if (op.after_heading && !after) {
      throw new EditError(`after_heading "${op.after_heading}" not found; ${headingsHint(headings)}`);
    }
    const level = Math.min(6, Math.max(1, op.level ?? after?.level ?? 2));
    const title = op.heading.replace(/^#+\s*/, "").trim();
    if (!title) throw new EditError("add_section requires a non-empty heading");
    const block = [`${"#".repeat(level)} ${title}`, "", ...contentLines(op.content, normalizeHeading(title))];

    let at: number;
    if (after) {
      at = sectionEnd(lines, headings, after);
    } else {
      const last = opts.keepLastHeading ? findHeading(headings, opts.keepLastHeading) : null;
      at = last && normalizeHeading(opts.keepLastHeading ?? "") === last.norm ? last.line : lines.length;
    }
    // Trim trailing blank lines at the end of document so the seam is clean.
    if (at === lines.length) {
      while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
      at = lines.length;
    }
    lines = spliceBlock(lines, at, at, block);
    return finish(lines);
  }

  const target = findHeading(headings, op.heading);
  if (!target) throw new EditError(`heading "${op.heading}" not found; ${headingsHint(headings)}`);
  const body = contentLines(op.content, target.norm);

  if (op.op === "append_to_section") {
    const end = sectionEnd(lines, headings, target);
    let at = end;
    while (at > target.line + 1 && lines[at - 1]!.trim() === "") at--;
    lines = spliceBlock(lines, at, end, body);
    return finish(lines);
  }

  // replace_section
  const end = bodyEnd(lines, headings, target);
  lines = spliceBlock(lines, target.line + 1, end, body);
  return finish(lines);
}

function finish(lines: string[]): string {
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  return lines.join("\n") + "\n";
}

/** Applies operations in order. Throws EditError naming the failing operation. */
export function applyEdits(markdown: string, ops: EditOp[], opts: ApplyOptions = {}): string {
  let text = markdown;
  ops.forEach((op, i) => {
    try {
      text = applyEdit(text, op, opts);
    } catch (err) {
      if (err instanceof EditError) throw new EditError(`edit #${i + 1} (${op.op}): ${err.message}`);
      throw err;
    }
  });
  return text;
}
