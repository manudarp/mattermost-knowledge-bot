import type { MattermostClient } from "../mattermost/client.js";
import type { OutlineClient } from "../outline/client.js";
import type { Logger } from "../logger.js";
import { config } from "../config.js";
import { parseCollectionArgs } from "./commandParser.js";
import { createCollection, listCollections, resolveCollectionRef, type OutlineCollection } from "../outline/collections.js";
import {
  GLOBAL_SCOPE,
  linkCollection,
  listLinkedCollections,
  refreshCollectionName,
  unlinkCollection,
} from "../db/repositories/channelCollections.js";
import { collectionUrl, getEffectiveCollections, pinnedCollections } from "./collectionScope.js";

export interface CollectionCommandCtx {
  mmClient: MattermostClient;
  outlineClient: OutlineClient;
  logger: Logger;
}

const SCOPE_LABEL = { env: "da .env", global: "globale", channel: "questo canale" } as const;

function isAdmin(username: string): boolean {
  return config.BOT_ADMINS.length === 0 || config.BOT_ADMINS.includes(username.toLowerCase());
}

function link(c: Pick<OutlineCollection, "id" | "urlId" | "name">): string {
  return `[${c.name}](${collectionUrl(c)})`;
}

/** Handles `@bot collezioni …` and returns the reply text. */
export async function handleCollectionsCommand(opts: {
  args: string;
  channelId: string;
  userId: string;
  username: string;
  ctx: CollectionCommandCtx;
}): Promise<string> {
  const { args, channelId, userId, username, ctx } = opts;
  const bot = `@${config.MM_BOT_USERNAME}`;
  const action = parseCollectionArgs(args);

  if (action.action === "invalid") {
    return `⚠️ ${action.reason}.\n\n${collectionsHelp()}`;
  }

  const all = await listCollections(ctx.outlineClient);
  const byId = new Map(all.map((c) => [c.id, c]));

  if (action.action === "list") {
    const effective = await getEffectiveCollections(ctx.outlineClient, ctx.logger, channelId);
    if (effective.length === 0) {
      return (
        "📚 Nessuna collection collegata a questo canale.\n" +
        `Usa \`${bot} collezioni disponibili\` per vederle e \`${bot} collezioni aggiungi <nome>\` per collegarle.`
      );
    }
    const lines = effective.map((c) => {
      const live = byId.get(c.id);
      if (live && live.name !== c.name) refreshCollectionName(c.id, live.name);
      return live
        ? `• ${link(live)} — _${SCOPE_LABEL[c.scope]}_`
        : `• ${c.name} — _${SCOPE_LABEL[c.scope]}_ ⚠️ non trovata in Outline (eliminata o senza permessi)`;
    });
    return `📚 **Collection usate in questo canale** (lettura per le domande, scrittura per \`salva\`):\n${lines.join("\n")}`;
  }

  if (action.action === "available") {
    const effectiveIds = new Set((await getEffectiveCollections(ctx.outlineClient, ctx.logger, channelId)).map((c) => c.id));
    if (all.length === 0) return "Il token Outline del bot non vede nessuna collection.";
    const lines = all
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => `${effectiveIds.has(c.id) ? "✅" : "▫️"} ${link(c)}`);
    return `📚 **Collection disponibili in Outline** (✅ = già collegata):\n${lines.join("\n")}`;
  }

  if (action.action === "create") {
    if (!isAdmin(username)) return "⛔ Solo gli amministratori del bot possono creare collection.";
    const created = await createCollection(ctx.outlineClient, { name: action.name, description: "" });
    linkCollection(channelId, created.id, created.name, userId);
    ctx.logger.info({ collection_id: created.id, channel_id: channelId }, "collection_created_and_linked");
    return `✅ Creata la collection ${link(created)} e collegata a questo canale.`;
  }

  // add / remove
  if (action.global && !isAdmin(username)) {
    return "⛔ Solo gli amministratori del bot (`BOT_ADMINS`) possono modificare le collection globali.";
  }
  const scope = action.global ? GLOBAL_SCOPE : channelId;
  const scopeText = action.global ? "a livello globale (tutti i canali)" : "a questo canale";
  const out: string[] = [];

  for (const ref of action.refs) {
    if (action.action === "add") {
      const r = resolveCollectionRef(ref, all);
      if ("none" in r) {
        out.push(`❓ «${ref}»: nessuna collection trovata (vedi \`${bot} collezioni disponibili\`).`);
        continue;
      }
      if ("ambiguous" in r) {
        out.push(`❓ «${ref}» è ambiguo: ${r.ambiguous.map((c) => c.name).join(", ")}. Usa il nome completo o il link.`);
        continue;
      }
      const added = linkCollection(scope, r.match.id, r.match.name, userId);
      out.push(added ? `✅ ${link(r.match)} collegata ${scopeText}.` : `ℹ️ ${link(r.match)} era già collegata ${scopeText}.`);
      ctx.logger.info({ collection_id: r.match.id, scope }, "collection_linked");
      continue;
    }

    // remove: resolve against what's linked in this scope first, so deleted
    // collections can still be unlinked by their cached name.
    const linked = listLinkedCollections(scope).map((l) => byId.get(l.outline_collection_id) ?? { id: l.outline_collection_id, name: l.collection_name });
    const r = resolveCollectionRef(ref, linked);
    if ("match" in r) {
      unlinkCollection(scope, r.match.id);
      out.push(`🗑️ «${r.match.name}» scollegata ${scopeText}. (La collection in Outline non viene toccata.)`);
      ctx.logger.info({ collection_id: r.match.id, scope }, "collection_unlinked");
      continue;
    }
    if ("ambiguous" in r) {
      out.push(`❓ «${ref}» è ambiguo: ${r.ambiguous.map((c) => c.name).join(", ")}.`);
      continue;
    }
    const pinned = resolveCollectionRef(ref, pinnedCollections());
    if ("match" in pinned) {
      out.push(`🔒 «${pinned.match.name}» è configurata in \`OUTLINE_COLLECTIONS\` (.env): rimuovila da lì.`);
    } else if (!action.global && "match" in resolveCollectionRef(ref, listLinkedCollections(GLOBAL_SCOPE).map((l) => ({ id: l.outline_collection_id, name: l.collection_name })))) {
      out.push(`🌐 «${ref}» è collegata a livello globale: usa \`${bot} collezioni rimuovi globale ${ref}\`.`);
    } else {
      out.push(`❓ «${ref}» non risulta collegata ${scopeText}.`);
    }
  }
  return out.join("\n");
}

export function collectionsHelp(): string {
  const bot = `@${config.MM_BOT_USERNAME}`;
  return `**Gestione collection:**
• \`${bot} collezioni\` — collection usate in questo canale
• \`${bot} collezioni disponibili\` — tutte le collection di Outline
• \`${bot} collezioni aggiungi <nome|link>[, <altra>…]\` — collega a questo canale
• \`${bot} collezioni rimuovi <nome|link>\` — scollega da questo canale
• \`${bot} collezioni aggiungi globale <nome>\` / \`rimuovi globale <nome>\` — per tutti i canali (admin)
• \`${bot} collezioni crea <nome>\` — crea una nuova collection in Outline e la collega (admin)`;
}
