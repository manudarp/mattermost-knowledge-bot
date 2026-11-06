import { db } from "../index.js";

/** Pseudo channel id for collections linked bot-wide. */
export const GLOBAL_SCOPE = "*";

export interface ChannelCollectionRow {
  mm_channel_id: string;
  outline_collection_id: string;
  collection_name: string;
  added_by_user_id: string;
  added_at: string;
}

const listForScopeStmt = db.prepare(
  "SELECT * FROM channel_collections WHERE mm_channel_id = ? ORDER BY collection_name",
);
const insertStmt = db.prepare(
  `INSERT INTO channel_collections (mm_channel_id, outline_collection_id, collection_name, added_by_user_id)
   VALUES (?, ?, ?, ?)
   ON CONFLICT(mm_channel_id, outline_collection_id) DO UPDATE SET collection_name = excluded.collection_name`,
);
const existsStmt = db.prepare(
  "SELECT 1 FROM channel_collections WHERE mm_channel_id = ? AND outline_collection_id = ?",
);
const deleteStmt = db.prepare(
  "DELETE FROM channel_collections WHERE mm_channel_id = ? AND outline_collection_id = ?",
);
const renameStmt = db.prepare(
  "UPDATE channel_collections SET collection_name = ? WHERE outline_collection_id = ? AND collection_name <> ?",
);

export function listLinkedCollections(scope: string): ChannelCollectionRow[] {
  return listForScopeStmt.all(scope) as ChannelCollectionRow[];
}

/** Returns false when the collection was already linked in that scope. */
export function linkCollection(scope: string, collectionId: string, name: string, userId: string): boolean {
  const existed = existsStmt.get(scope, collectionId) !== undefined;
  insertStmt.run(scope, collectionId, name, userId);
  return !existed;
}

export function unlinkCollection(scope: string, collectionId: string): boolean {
  return deleteStmt.run(scope, collectionId).changes > 0;
}

/** Keeps cached names in sync after a rename in Outline. */
export function refreshCollectionName(collectionId: string, name: string): void {
  renameStmt.run(name, collectionId, name);
}
