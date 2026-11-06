import type { OutlineClient } from "../outline/client.js";
import type { Logger } from "../logger.js";
import { config } from "../config.js";
import { listCollections, resolveCollectionRef, type OutlineCollection } from "../outline/collections.js";
import { GLOBAL_SCOPE, listLinkedCollections } from "../db/repositories/channelCollections.js";

export type CollectionScopeKind = "env" | "global" | "channel";

export interface ScopedCollection {
  id: string;
  name: string;
  scope: CollectionScopeKind;
}

// Collections pinned via OUTLINE_COLLECTIONS, resolved to IDs lazily (Outline
// may be unreachable at boot; we retry on next use).
let pinned: ScopedCollection[] | null = null;
let pinnedPromise: Promise<void> | null = null;

async function resolvePinned(outlineClient: OutlineClient, logger: Logger): Promise<void> {
  if (config.OUTLINE_COLLECTIONS.length === 0) {
    pinned = [];
    return;
  }
  const all = await listCollections(outlineClient);
  const resolved: ScopedCollection[] = [];
  for (const ref of config.OUTLINE_COLLECTIONS) {
    const r = resolveCollectionRef(ref, all);
    if ("match" in r) {
      resolved.push({ id: r.match.id, name: r.match.name, scope: "env" });
    } else if ("ambiguous" in r) {
      logger.warn({ ref, candidates: r.ambiguous.map((c) => c.name) }, "pinned_collection_ambiguous");
    } else {
      logger.warn({ ref }, "pinned_collection_not_found");
    }
  }
  pinned = resolved;
  logger.info({ collections: resolved.map((c) => c.name) }, "pinned_collections_resolved");
}

export async function ensurePinnedCollections(outlineClient: OutlineClient, logger: Logger): Promise<void> {
  if (pinned) return;
  pinnedPromise ??= resolvePinned(outlineClient, logger).catch((err) => {
    logger.warn({ err }, "pinned_collections_resolve_failed");
  }).finally(() => {
    pinnedPromise = null;
  });
  await pinnedPromise;
}

export function pinnedCollections(): ScopedCollection[] {
  return pinned ?? [];
}

/** All collections the bot may use in a channel: env-pinned ∪ global ∪ channel. */
export async function getEffectiveCollections(
  outlineClient: OutlineClient,
  logger: Logger,
  channelId: string,
): Promise<ScopedCollection[]> {
  await ensurePinnedCollections(outlineClient, logger);
  const out = new Map<string, ScopedCollection>();
  for (const c of pinnedCollections()) out.set(c.id, c);
  for (const r of listLinkedCollections(GLOBAL_SCOPE)) {
    if (!out.has(r.outline_collection_id)) {
      out.set(r.outline_collection_id, { id: r.outline_collection_id, name: r.collection_name, scope: "global" });
    }
  }
  for (const r of listLinkedCollections(channelId)) {
    if (!out.has(r.outline_collection_id)) {
      out.set(r.outline_collection_id, { id: r.outline_collection_id, name: r.collection_name, scope: "channel" });
    }
  }
  return [...out.values()];
}

export function collectionUrl(c: Pick<OutlineCollection, "id" | "urlId">): string {
  return `${config.OUTLINE_URL.replace(/\/$/, "")}/collection/${c.urlId ?? c.id}`;
}
