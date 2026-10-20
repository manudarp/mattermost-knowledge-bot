import type { OutlineClient } from "./client.js";

export interface OutlineCollection {
  id: string;
  name: string;
  urlId?: string;
  description?: string | null;
  permission?: string | null;
  url?: string;
}

/** Node of `collections.documents` — the sidebar tree of a collection. */
export interface NavigationNode {
  id: string;
  title: string;
  url: string;
  children: NavigationNode[];
}

export async function createCollection(
  client: OutlineClient,
  opts: { name: string; description?: string },
): Promise<OutlineCollection> {
  const res = await client.post<OutlineCollection>("/collections.create", {
    name: opts.name,
    description: opts.description ?? "",
    permission: "read",
  });
  if (typeof res?.id !== "string") {
    throw new Error(`Outline response missing expected fields: ${JSON.stringify(res)}`);
  }
  return res;
}

export async function listCollections(client: OutlineClient): Promise<OutlineCollection[]> {
  const limit = 100;
  const all: OutlineCollection[] = [];
  for (let offset = 0; ; offset += limit) {
    const res = await client.post<OutlineCollection[] | { data: OutlineCollection[] }>("/collections.list", {
      limit,
      offset,
    });
    const page = Array.isArray(res) ? res : (res.data ?? []);
    all.push(...page);
    if (page.length < limit) break;
  }
  return all;
}

export async function getCollectionTree(client: OutlineClient, collectionId: string): Promise<NavigationNode[]> {
  const res = await client.post<NavigationNode[]>("/collections.documents", { id: collectionId });
  return Array.isArray(res) ? res : [];
}

/** Last dash-separated token of an Outline slug ("my-collection-AbC123xyZ" → "AbC123xyZ"). */
function trailingUrlId(slug: string): string {
  const parts = slug.split("-");
  return parts[parts.length - 1] ?? slug;
}

/**
 * Resolves a user-supplied reference (name, URL, UUID or urlId) against the
 * list of collections. Exact matches win; a substring match is accepted only
 * when unambiguous.
 */
export function resolveCollectionRef(
  ref: string,
  collections: OutlineCollection[],
): { match: OutlineCollection } | { ambiguous: OutlineCollection[] } | { none: true } {
  const raw = ref.trim().replace(/^["'«]|["'»]$/g, "");
  if (!raw) return { none: true };

  let key = raw;
  const urlMatch = /\/collection\/([^/?#]+)/.exec(raw);
  if (urlMatch?.[1]) key = urlMatch[1];

  const byId = collections.find(
    (c) => c.id === key || (c.urlId && (c.urlId === key || c.urlId === trailingUrlId(key))),
  );
  if (byId) return { match: byId };

  const lower = raw.toLowerCase();
  const exact = collections.filter((c) => c.name.toLowerCase() === lower);
  if (exact.length === 1) return { match: exact[0]! };
  if (exact.length > 1) return { ambiguous: exact };

  const partial = collections.filter((c) => c.name.toLowerCase().includes(lower));
  if (partial.length === 1) return { match: partial[0]! };
  if (partial.length > 1) return { ambiguous: partial };
  return { none: true };
}

/** Flattens a navigation tree to "path" entries, depth-first. */
export function flattenTree(
  nodes: NavigationNode[],
  parents: string[] = [],
): Array<{ id: string; title: string; url: string; path: string[]; depth: number }> {
  const out: Array<{ id: string; title: string; url: string; path: string[]; depth: number }> = [];
  for (const n of nodes) {
    out.push({ id: n.id, title: n.title, url: n.url, path: [...parents, n.title], depth: parents.length });
    if (n.children?.length) out.push(...flattenTree(n.children, [...parents, n.title]));
  }
  return out;
}
