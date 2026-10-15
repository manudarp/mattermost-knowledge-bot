import type { OutlineClient } from "./client.js";

export interface OutlineDocument {
  id: string;
  title: string;
  text: string;
  revision?: number;
  urlId?: string;
  collectionId?: string;
  parentDocumentId?: string | null;
  url?: string;
  deletedAt?: string | null;
  archivedAt?: string | null;
}

/** Absolute browser URL for a document (Outline returns `url` as a path). */
export function documentUrl(outlineUrl: string, doc: { url?: string; urlId?: string; id: string }): string {
  const base = outlineUrl.replace(/\/$/, "");
  if (doc.url) return doc.url.startsWith("/") ? `${base}${doc.url}` : doc.url;
  return `${base}/doc/${doc.urlId ?? doc.id}`;
}

/**
 * Extracts something `documents.info` accepts from a user reference:
 * a full URL (".../doc/title-AbC123"), a "/doc/..." path, a UUID or a urlId.
 * Returns null when the text doesn't look like a document reference.
 */
export function documentRefFromText(ref: string): string | null {
  const t = ref.trim().replace(/^<|>$/g, "");
  const m = /\/doc\/([^/?#\s)]+)/.exec(t);
  if (m?.[1]) {
    const parts = m[1].split("-");
    return parts[parts.length - 1] ?? null;
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t)) return t;
  if (/^[A-Za-z0-9]{10}$/.test(t)) return t;
  return null;
}

export async function createDocument(
  client: OutlineClient,
  opts: { collectionId: string; title: string; text: string; parentDocumentId?: string | null },
): Promise<OutlineDocument> {
  const res = await client.post<OutlineDocument>("/documents.create", {
    collectionId: opts.collectionId,
    ...(opts.parentDocumentId ? { parentDocumentId: opts.parentDocumentId } : {}),
    title: opts.title,
    text: opts.text,
    publish: true,
  });
  if (typeof res?.id !== "string" || typeof res?.title !== "string") {
    throw new Error(`Outline response missing expected fields: ${JSON.stringify(res)}`);
  }
  return res;
}

export async function getDocument(client: OutlineClient, id: string): Promise<OutlineDocument> {
  const res = await client.post<OutlineDocument>("/documents.info", { id });
  if (typeof res?.id !== "string" || typeof res?.title !== "string") {
    throw new Error(`Outline response missing expected fields: ${JSON.stringify(res)}`);
  }
  return res;
}

export async function updateDocument(
  client: OutlineClient,
  opts: { id: string; text: string; title?: string },
): Promise<OutlineDocument> {
  const res = await client.post<OutlineDocument>("/documents.update", {
    id: opts.id,
    ...(opts.title ? { title: opts.title } : {}),
    text: opts.text,
    append: false,
  });
  if (typeof res?.id !== "string" || typeof res?.title !== "string") {
    throw new Error(`Outline response missing expected fields: ${JSON.stringify(res)}`);
  }
  return res;
}

export async function deleteDocument(client: OutlineClient, id: string): Promise<void> {
  await client.post("/documents.delete", { id, permanent: true });
}

interface DocumentListResponse {
  data: OutlineDocument[];
  pagination: { total: number; limit: number; offset: number };
}

export async function* listAllDocuments(client: OutlineClient): AsyncGenerator<OutlineDocument> {
  const limit = 25;
  let offset = 0;

  while (true) {
    const res = await client.post<DocumentListResponse>("/documents.list", {
      limit,
      offset,
      sort: "updatedAt",
      direction: "DESC",
    });

    const docs: OutlineDocument[] = Array.isArray(res)
      ? (res as OutlineDocument[])
      : ((res as DocumentListResponse).data ?? []);

    for (const doc of docs) {
      // Fetch full text (list endpoint returns truncated text)
      try {
        const full = await client.post<OutlineDocument>("/documents.info", { id: doc.id });
        yield full;
      } catch {
        yield doc;
      }
    }

    if (docs.length < limit) break;
    offset += limit;
  }
}
