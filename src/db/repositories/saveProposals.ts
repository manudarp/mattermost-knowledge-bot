import { db } from "../index.js";

export type ProposalStatus = "pending" | "working" | "applied" | "cancelled" | "failed" | "expired";

export interface SaveProposalRow {
  id: number;
  mm_channel_id: string;
  mm_thread_root_id: string;
  mm_trigger_post_id: string;
  bot_reply_post_id: string;
  requested_by_user_id: string;
  status: ProposalStatus;
  payload_json: string;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

const insertStmt = db.prepare(
  `INSERT INTO save_proposals (mm_channel_id, mm_thread_root_id, mm_trigger_post_id, bot_reply_post_id,
     requested_by_user_id, status, payload_json, expires_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
);
const findByIdStmt = db.prepare("SELECT * FROM save_proposals WHERE id = ?");
const findByBotReplyStmt = db.prepare("SELECT * FROM save_proposals WHERE bot_reply_post_id = ?");
const findByTriggerStmt = db.prepare("SELECT * FROM save_proposals WHERE mm_trigger_post_id = ?");
const findActiveByThreadStmt = db.prepare(
  `SELECT * FROM save_proposals
   WHERE mm_thread_root_id = ? AND status = 'pending' AND expires_at > ?
   ORDER BY id DESC LIMIT 1`,
);
const countPendingByChannelStmt = db.prepare(
  "SELECT COUNT(*) AS n FROM save_proposals WHERE mm_channel_id = ? AND status = 'pending' AND expires_at > ?",
);
const transitionStmt = db.prepare(
  "UPDATE save_proposals SET status = ?, updated_at = datetime('now') WHERE id = ? AND status = ?",
);
const setStatusStmt = db.prepare(
  "UPDATE save_proposals SET status = ?, updated_at = datetime('now') WHERE id = ?",
);
const updatePayloadStmt = db.prepare(
  "UPDATE save_proposals SET payload_json = ?, expires_at = ?, updated_at = datetime('now') WHERE id = ?",
);
const expireStmt = db.prepare(
  "UPDATE save_proposals SET status = 'expired', updated_at = datetime('now') WHERE status = 'pending' AND expires_at <= ? RETURNING *",
);

export function insertProposal(row: {
  mm_channel_id: string;
  mm_thread_root_id: string;
  mm_trigger_post_id: string;
  bot_reply_post_id: string;
  requested_by_user_id: string;
  status: ProposalStatus;
  payload_json: string;
  expires_at: string;
}): SaveProposalRow {
  return insertStmt.get(
    row.mm_channel_id,
    row.mm_thread_root_id,
    row.mm_trigger_post_id,
    row.bot_reply_post_id,
    row.requested_by_user_id,
    row.status,
    row.payload_json,
    row.expires_at,
  ) as SaveProposalRow;
}

export function findProposalById(id: number): SaveProposalRow | null {
  return (findByIdStmt.get(id) as SaveProposalRow | undefined) ?? null;
}

export function findProposalByBotReply(postId: string): SaveProposalRow | null {
  return (findByBotReplyStmt.get(postId) as SaveProposalRow | undefined) ?? null;
}

export function findProposalByTrigger(postId: string): SaveProposalRow | null {
  return (findByTriggerStmt.get(postId) as SaveProposalRow | undefined) ?? null;
}

export function findActiveProposalByThread(rootId: string): SaveProposalRow | null {
  return (findActiveByThreadStmt.get(rootId, new Date().toISOString()) as SaveProposalRow | undefined) ?? null;
}

export function countPendingProposals(channelId: string): number {
  return (countPendingByChannelStmt.get(channelId, new Date().toISOString()) as { n: number }).n;
}

/** Atomic compare-and-set; returns false when another handler got there first. */
export function transitionProposal(id: number, from: ProposalStatus, to: ProposalStatus): boolean {
  return transitionStmt.run(to, id, from).changes === 1;
}

export function setProposalStatus(id: number, status: ProposalStatus): void {
  setStatusStmt.run(status, id);
}

export function updateProposalPayload(id: number, payloadJson: string, expiresAt: string): void {
  updatePayloadStmt.run(payloadJson, expiresAt, id);
}

export function expireProposals(nowIso: string): SaveProposalRow[] {
  return expireStmt.all(nowIso) as SaveProposalRow[];
}
