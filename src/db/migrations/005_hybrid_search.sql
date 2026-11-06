-- New chunker (all heading levels, bounded chunk size) + hybrid search.
-- Old chunks are incompatible (different boundaries, JSON vectors): drop them
-- and force a full re-index on the next sync.
DROP TABLE IF EXISTS document_chunks;
DELETE FROM index_state;

CREATE TABLE document_chunks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id        TEXT    NOT NULL,              -- Outline document UUID
  doc_title     TEXT    NOT NULL,
  doc_url       TEXT    NOT NULL,
  collection_id TEXT    NOT NULL DEFAULT '',
  chunk_index   INTEGER NOT NULL,
  heading       TEXT    NOT NULL,              -- heading path inside the document ("A › B")
  content       TEXT    NOT NULL,
  embedding     BLOB    NOT NULL,              -- Float32Array, little-endian
  indexed_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (doc_id, chunk_index)
);

CREATE INDEX idx_chunks_doc ON document_chunks(doc_id);
CREATE INDEX idx_chunks_collection ON document_chunks(collection_id);

-- Keyword index (BM25) over the same rows, kept in sync by triggers.
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  doc_title, heading, content,
  content = 'document_chunks',
  content_rowid = 'id',
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER document_chunks_ai AFTER INSERT ON document_chunks BEGIN
  INSERT INTO chunks_fts (rowid, doc_title, heading, content) VALUES (new.id, new.doc_title, new.heading, new.content);
END;
CREATE TRIGGER document_chunks_ad AFTER DELETE ON document_chunks BEGIN
  INSERT INTO chunks_fts (chunks_fts, rowid, doc_title, heading, content) VALUES ('delete', old.id, old.doc_title, old.heading, old.content);
END;
CREATE TRIGGER document_chunks_au AFTER UPDATE ON document_chunks BEGIN
  INSERT INTO chunks_fts (chunks_fts, rowid, doc_title, heading, content) VALUES ('delete', old.id, old.doc_title, old.heading, old.content);
  INSERT INTO chunks_fts (rowid, doc_title, heading, content) VALUES (new.id, new.doc_title, new.heading, new.content);
END;

-- Small key/value store (e.g. which embedding model built the index).
CREATE TABLE IF NOT EXISTS bot_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
