import type { WsEvent } from "../websocket.js";
import type { MattermostClient } from "../client.js";
import type { OutlineClient } from "../../outline/client.js";
import type { Logger } from "../../logger.js";
import { findProposalByBotReply } from "../../db/repositories/saveProposals.js";
import { applyProposal, cancelProposal, canDecide } from "../../core/smartSave.js";
import { withChannelLock } from "../../utils/locks.js";

interface ReactionAddedCtx {
  client: MattermostClient;
  outlineClient: OutlineClient;
  logger: Logger;
  botUserId: string;
}

type ReactionAddedEvent = Extract<WsEvent, { event: "reaction_added" }>;

interface Reaction {
  user_id: string;
  post_id: string;
  emoji_name: string;
  create_at: number;
}

const APPROVE_EMOJIS = new Set(["+1", "thumbsup", "white_check_mark", "heavy_check_mark", "ballot_box_with_check"]);
const CANCEL_EMOJIS = new Set(["-1", "thumbsdown", "x", "negative_squared_cross_mark", "no_entry_sign"]);

export async function handleReactionAdded(event: ReactionAddedEvent, ctx: ReactionAddedCtx): Promise<void> {
  const { client, outlineClient, logger, botUserId } = ctx;

  let reaction: Reaction;
  try {
    const raw = event.data.reaction;
    const parsed: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      !("post_id" in parsed) ||
      !("user_id" in parsed) ||
      !("emoji_name" in parsed)
    ) {
      logger.debug({ raw }, "reaction_added_missing_fields");
      return;
    }
    reaction = parsed as Reaction;
  } catch {
    logger.warn({ raw: event.data.reaction }, "reaction_added_invalid_json");
    return;
  }

  if (reaction.user_id === botUserId) return;
  const approve = APPROVE_EMOJIS.has(reaction.emoji_name);
  const cancel = CANCEL_EMOJIS.has(reaction.emoji_name);
  if (!approve && !cancel) return;

  const proposal = findProposalByBotReply(reaction.post_id);
  if (!proposal || proposal.status !== "pending") return;
  if (new Date(proposal.expires_at).getTime() <= Date.now()) return;

  const [user] = await client.getUsersByIds([reaction.user_id]).catch(() => []);
  const username = user?.username ?? reaction.user_id;
  if (!canDecide(proposal, reaction.user_id, user?.username ?? null)) {
    logger.info({ proposal_id: proposal.id, user_id: reaction.user_id }, "proposal_reaction_ignored_not_allowed");
    return;
  }

  logger.info({ proposal_id: proposal.id, emoji: reaction.emoji_name, user_id: reaction.user_id }, "proposal_reaction_received");

  const saveCtx = { mmClient: client, outlineClient, logger, botUserId };
  await withChannelLock(proposal.mm_channel_id, async () => {
    try {
      if (approve) {
        await applyProposal({ proposal, actorUserId: reaction.user_id, actorUsername: username, ctx: saveCtx });
      } else {
        await cancelProposal({ proposal, actorUsername: username, ctx: saveCtx });
      }
    } catch (err) {
      logger.error({ err, proposal_id: proposal.id }, "proposal_reaction_failed");
    }
  });
}
