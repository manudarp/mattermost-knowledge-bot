/**
 * Splits an Outline Markdown document into retrieval chunks.
 *
 * - Every heading level (# … ######) starts a new section; headings inside
 *   fenced code blocks are ignored.
 * - Each chunk carries its heading path ("Sincronizzatore › Servizi SOAP") so
 *   a chunk taken out of a long document still says what it is about.
 * - Sections longer than `maxChars` are split on paragraph boundaries (a fenced
 *   code block counts as one paragraph), then lines, then characters, with a
 *   small overlap so a sentence cut at a boundary is still found.
 */

export interface DocumentChunk {
  chunkIndex: number;
  /** Heading path inside the document (without the title); the title for text before the first heading. */
  heading: string;
  content: string;
}

export interface ChunkOptions {
  maxChars?: number;
  overlapChars?: number;
}

const MIN_CHUNK_LENGTH = 10;
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE_RE = /^\s*(```|~~~)/;
export const PATH_SEPARATOR = " › ";

interface Section {
  path: string[];
  lines: string[];
}

/** Outline-specific noise that only hurts retrieval: images, hard-break backslashes. */
function cleanLine(line: string): string {
  return line
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\\$/, "");
}

function splitSections(text: string): Section[] {
  const sections: Section[] = [];
  const stack: string[] = [];
  let current: Section = { path: [], lines: [] };
  let inFence = false;

  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    if (FENCE_RE.test(raw)) {
      inFence = !inFence;
      current.lines.push(raw);
      continue;
    }
    const m = inFence ? null : HEADING_RE.exec(raw);
    if (m) {
      sections.push(current);
      const level = m[1]!.length;
      const title = (m[2] ?? "").replace(/[*_`]/g, "").trim();
      stack.length = Math.min(stack.length, level - 1);
      while (stack.length < level - 1) stack.push("");
      stack.push(title);
      current = { path: stack.filter(Boolean), lines: [] };
      continue;
    }
    current.lines.push(inFence ? raw : cleanLine(raw));
  }
  sections.push(current);
  return sections;
}

/** Paragraphs separated by blank lines; a fenced block is kept whole. */
function paragraphs(lines: string[]): string[] {
  const out: string[] = [];
  let buf: string[] = [];
  let inFence = false;
  const flush = () => {
    const p = buf.join("\n").trim();
    if (p) out.push(p);
    buf = [];
  };
  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      if (!inFence) flush();
      inFence = !inFence;
      buf.push(line);
      if (!inFence) flush();
      continue;
    }
    if (!inFence && line.trim() === "") {
      flush();
      continue;
    }
    buf.push(line);
  }
  flush();
  return out;
}

/** Breaks a single over-long paragraph into pieces ≤ max (lines first, then characters). */
function hardSplit(p: string, max: number): string[] {
  const out: string[] = [];
  let buf = "";
  for (const line of p.split("\n")) {
    if (line.length > max) {
      if (buf) out.push(buf);
      buf = "";
      for (let i = 0; i < line.length; i += max) out.push(line.slice(i, i + max));
      continue;
    }
    if (buf && buf.length + 1 + line.length > max) {
      out.push(buf);
      buf = line;
    } else {
      buf = buf ? `${buf}\n${line}` : line;
    }
  }
  if (buf) out.push(buf);
  return out;
}

/** Tail of a chunk used as overlap, cut at a line or word boundary. */
function overlapTail(text: string, overlap: number): string {
  if (overlap <= 0) return "";
  if (text.length <= overlap) return text;
  const tail = text.slice(-overlap);
  const nl = tail.indexOf("\n");
  if (nl !== -1 && nl < tail.length - 1) return tail.slice(nl + 1);
  const sp = tail.indexOf(" ");
  return sp !== -1 ? tail.slice(sp + 1) : tail;
}

function packSection(body: string[], max: number, overlap: number): string[] {
  const units = paragraphs(body).flatMap((p) => (p.length > max ? hardSplit(p, max) : [p]));
  const chunks: string[] = [];
  let buf = "";
  for (const u of units) {
    if (buf && buf.length + 2 + u.length > max) {
      chunks.push(buf);
      const tail = overlapTail(buf, overlap);
      buf = tail && tail.length + 2 + u.length <= max ? `${tail}\n\n${u}` : u;
    } else {
      buf = buf ? `${buf}\n\n${u}` : u;
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

export function chunkDocument(text: string, title: string, opts: ChunkOptions = {}): DocumentChunk[] {
  const max = opts.maxChars ?? 1800;
  const overlap = Math.min(opts.overlapChars ?? 200, Math.floor(max / 3));
  const chunks: DocumentChunk[] = [];

  for (const s of splitSections(text)) {
    const heading = s.path.length > 0 ? s.path.join(PATH_SEPARATOR) : title;
    for (const content of packSection(s.lines, max, overlap)) {
      if (content.trim().length < MIN_CHUNK_LENGTH) continue;
      chunks.push({ chunkIndex: chunks.length, heading, content });
    }
  }
  return chunks;
}

/** Text actually embedded: title and heading path give the vector its context. */
export function embeddingText(docTitle: string, chunk: Pick<DocumentChunk, "heading" | "content">): string {
  const path = chunk.heading === docTitle ? docTitle : `${docTitle}${PATH_SEPARATOR}${chunk.heading}`;
  return `${path}\n\n${chunk.content}`;
}
