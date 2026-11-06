-- Change detection without downloading every document on every sync:
--  doc_updated_at → compared with documents.list's updatedAt; equal means "unchanged",
--                   so documents.info is not called at all.
--  text_hash      → hash of the full text that was indexed; detects documents that
--                   were indexed from a truncated text (older versions fell back to
--                   the list's truncated text when documents.info was rate limited).
ALTER TABLE index_state ADD COLUMN doc_updated_at TEXT;
ALTER TABLE index_state ADD COLUMN text_hash TEXT;
