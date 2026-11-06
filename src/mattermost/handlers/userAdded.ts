import type { WsEvent } from "../websocket.js";
import type { MattermostClient } from "../client.js";
import type { OutlineClient } from "../../outline/client.js";
import type { Logger } from "../../logger.js";
import { config } from "../../config.js";
import { withChannelLock } from "../../utils/locks.js";
import { ensureChannelRegistered } from "../../core/channelRegistry.js";
import { getEffectiveCollections, collectionUrl } from "../../core/collectionScope.js";

interface UserAddedCtx {
  client: MattermostClient;
  outlineClient: OutlineClient;
  logger: Logger;
  botUserId: string;
}

type UserAddedEvent = Extract<WsEvent, { event: "user_added" }>;

export async function handleUserAdded(event: UserAddedEvent, ctx: UserAddedCtx): Promise<void> {
  const { client, outlineClient, logger, botUserId } = ctx;

  if (event.data.user_id !== botUserId) return;

  const channelId = event.broadcast.channel_id;

  await withChannelLock(channelId, async () => {
    try {
      const channel = await client.getChannel(channelId);
      logger.info(
        { channel_id: channel.id, channel_name: channel.name, display_name: channel.display_name, team_id: channel.team_id },
        "bot_added_to_channel",
      );

      const { created, homeCollection } = await ensureChannelRegistered({
        channelId,
        mmClient: client,
        outlineClient,
        logger,
        botUserId,
        channel,
      });

      const bot = `@${config.MM_BOT_USERNAME}`;
      const collections = await getEffectiveCollections(outlineClient, logger, channelId);
      const collectionsLine =
        collections.length > 0
          ? `📚 Collection Outline che uso qui: ${collections.map((c) => `[${c.name}](${collectionUrl(c)})`).join(", ")}`
          : `📚 Nessuna collection Outline collegata: usa \`${bot} collezioni disponibili\` e \`${bot} collezioni aggiungi <nome>\`.`;

      const intro = created ? "👋 Ciao! Sono il Knowledge Bot." : "👋 Bentornato!";
      const home = homeCollection
        ? ` Ho creato la collection [${homeCollection.name}](${collectionUrl(homeCollection)}) per questo canale.`
        : "";

      await client.createPost({
        channel_id: channelId,
        message: `${intro}${home}
${collectionsLine}

• \`${bot} <domanda>\` — rispondo usando la knowledge base (o conoscenze generali)
• \`${bot} salva\` in un thread — propongo dove e come salvare la discussione in Outline, e applico solo dopo la vostra conferma
• \`${bot} help\` — tutti i comandi`,
      });
    } catch (err) {
      logger.error({ err, channel_id: channelId }, "user_added_handler_failed");
    }
  });
}
