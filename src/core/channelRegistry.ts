import type { MattermostClient, Channel } from "../mattermost/client.js";
import type { OutlineClient } from "../outline/client.js";
import type { Logger } from "../logger.js";
import { config } from "../config.js";
import { findChannelByMmId, insertChannel, type ChannelRow } from "../db/repositories/channels.js";
import { linkCollection } from "../db/repositories/channelCollections.js";
import { createCollection, type OutlineCollection } from "../outline/collections.js";

/**
 * Registers a Mattermost channel the first time the bot sees it (join event or
 * first mention — e.g. DMs never emit user_added). With
 * AUTO_CREATE_CHANNEL_COLLECTION the legacy behaviour is kept: a dedicated
 * Outline collection is created and linked to the channel.
 */
export async function ensureChannelRegistered(opts: {
  channelId: string;
  mmClient: MattermostClient;
  outlineClient: OutlineClient;
  logger: Logger;
  botUserId: string;
  channel?: Channel;
}): Promise<{ row: ChannelRow; created: boolean; homeCollection: OutlineCollection | null }> {
  const { channelId, mmClient, outlineClient, logger, botUserId } = opts;

  const existing = findChannelByMmId(channelId);
  if (existing) return { row: existing, created: false, homeCollection: null };

  const channel = opts.channel ?? (await mmClient.getChannel(channelId));
  // Direct/group messages never get a dedicated collection.
  const isDirect = channel.type === "D" || channel.type === "G";

  let homeCollection: OutlineCollection | null = null;
  if (config.AUTO_CREATE_CHANNEL_COLLECTION && !isDirect) {
    homeCollection = await createCollection(outlineClient, {
      name: channel.display_name || channel.name,
      description: `Knowledge base for #${channel.name}`,
    });
    logger.info({ channel_id: channel.id, collection_id: homeCollection.id }, "outline_collection_created");
  }

  insertChannel({
    mm_channel_id: channel.id,
    mm_channel_name: isDirect ? `dm-${channel.id}` : channel.name,
    outline_collection_id: homeCollection?.id ?? null,
    created_by_user_id: botUserId,
  });
  if (homeCollection) linkCollection(channel.id, homeCollection.id, homeCollection.name, botUserId);

  logger.info({ channel_id: channel.id, channel_name: channel.name }, "channel_registered");
  return { row: findChannelByMmId(channelId)!, created: true, homeCollection };
}
