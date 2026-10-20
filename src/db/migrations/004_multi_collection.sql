-- A channel is no longer tied to exactly one Outline collection.
-- channels.outline_collection_id becomes an optional "home" collection (the one
-- auto-created on join, if AUTO_CREATE_CHANNEL_COLLECTION is on) and loses its
-- UNIQUE constraint. Rebuild per SQLite's ALTER TABLE procedure; the migration
-- runner disables foreign keys around migrations so topics aren't cascaded.
CREATE TABLE channels_new (
  mm_channel_id          TEXT PRIMARY KEY,
  mm_channel_name        TEXT NOT NULL,
  outline_collection_id  TEXT,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  created_by_user_id     TEXT NOT NULL
);
INSERT INTO channels_new (mm_channel_id, mm_channel_name, outline_collection_id, created_at, created_by_user_id)
  SELECT mm_channel_id, mm_channel_name, outline_collection_id, created_at, created_by_user_id FROM channels;
DROP TABLE channels;
ALTER TABLE channels_new RENAME TO channels;

-- Collections the bot may read from / write to.
-- mm_channel_id = '*' means bot-wide (every channel).
CREATE TABLE IF NOT EXISTS channel_collections (
  mm_channel_id          TEXT NOT NULL,
  outline_collection_id  TEXT NOT NULL,
  collection_name        TEXT NOT NULL,
  added_by_user_id       TEXT NOT NULL,
  added_at               TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (mm_channel_id, outline_collection_id)
);

INSERT OR IGNORE INTO channel_collections (mm_channel_id, outline_collection_id, collection_name, added_by_user_id)
  SELECT mm_channel_id, outline_collection_id, mm_channel_name, created_by_user_id
  FROM channels WHERE outline_collection_id IS NOT NULL AND outline_collection_id <> '';

-- Proposed knowledge-base changes awaiting human approval.
CREATE TABLE IF NOT EXISTS save_proposals (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  mm_channel_id         TEXT NOT NULL,
  mm_thread_root_id     TEXT NOT NULL,
  mm_trigger_post_id    TEXT NOT NULL UNIQUE,
  bot_reply_post_id     TEXT NOT NULL,
  requested_by_user_id  TEXT NOT NULL,
  status                TEXT NOT NULL CHECK (status IN ('pending','working','applied','cancelled','failed','expired')),
  payload_json          TEXT NOT NULL,
  expires_at            TEXT NOT NULL,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_proposals_thread ON save_proposals(mm_thread_root_id, status);
CREATE INDEX IF NOT EXISTS idx_proposals_bot_reply ON save_proposals(bot_reply_post_id);

-- Chunks indexed before 003 have an empty collection_id and would be invisible
-- to collection-scoped search forever (the revision check skips them). Force a
-- re-index of those documents on the next sync.
DELETE FROM index_state WHERE doc_id IN (SELECT DISTINCT doc_id FROM document_chunks WHERE collection_id = '');
