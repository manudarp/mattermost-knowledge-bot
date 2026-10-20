/**
 * Isolates the JSON object in a model reply that may be wrapped in ```json
 * fences or surrounded by prose.
 *
 * The JSON itself often contains Markdown with its own ``` code fences (a new
 * document's body, section edits…), so fences must never be matched inside the
 * payload: candidates are tried in order and the first one that parses wins.
 */
export function stripJsonFences(text: string): string {
  const candidates = jsonCandidates(text);
  for (const c of candidates) {
    try {
      JSON.parse(c);
      return c;
    } catch {
      /* try the next candidate */
    }
  }
  // Nothing parses: return the most plausible candidate so the caller's
  // error message points at the real problem.
  return candidates[candidates.length - 1] ?? text.trim();
}

function jsonCandidates(text: string): string[] {
  const out: string[] = [];
  const trimmed = text.trim();
  out.push(trimmed);

  // Outer fence only: ```json\n … \n``` around the whole reply.
  const outer = /^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?\s*```\s*$/.exec(trimmed);
  if (outer?.[1]) out.push(outer[1].trim());

  // First balanced {...}, skipping braces that appear inside JSON strings.
  const balanced = firstBalancedObject(trimmed);
  if (balanced) out.push(balanced);

  return [...new Set(out)];
}

export function firstBalancedObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
