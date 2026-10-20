import type { Logger } from "../logger.js";
import type { MattermostClient } from "../mattermost/client.js";
import { expireProposals } from "../db/repositories/saveProposals.js";
import { markProposalExpired } from "../core/smartSave.js";

export function startConfirmationCleanup(
  intervalMinutes: number,
  mmClient: MattermostClient,
  logger: Logger,
): { stop: () => void } {
  const intervalMs = intervalMinutes * 60_000;

  async function tick(): Promise<void> {
    try {
      const expired = expireProposals(new Date().toISOString());
      for (const p of expired) {
        await markProposalExpired(p, mmClient).catch((err) =>
          logger.warn({ err, proposal_id: p.id }, "proposal_expired_post_update_failed"),
        );
      }
      if (expired.length > 0) logger.info({ expired: expired.length }, "proposal_cleanup_swept");
    } catch (err) {
      logger.error({ err }, "proposal_cleanup_failed");
    }
  }

  void tick();
  const handle = setInterval(() => void tick(), intervalMs);

  logger.info({ interval_minutes: intervalMinutes }, "confirmation_cleanup_started");

  return {
    stop(): void {
      clearInterval(handle);
    },
  };
}
