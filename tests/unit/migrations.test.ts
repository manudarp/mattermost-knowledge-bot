import { describe, it, expect, afterAll } from "vitest";
import Database from "better-sqlite3";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const file = join(tmpdir(), `kb-bot-migration-test-${process.pid}-${Date.now()}.db`);

/** Builds a database as it looked before 004 (one collection per channel), with data. */
function seedLegacyDb(path: string): void {
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  db.exec("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))");
  for (const f of ["001_initial.sql", "002_rag.sql", "003_collection_id.sql"]) {
    db.exec(readFileSync(join("src/db/migrations", f), "utf8"));
    db.prepare("INSERT INTO schema_migrations (name) VALUES (?)").run(f);
  }
  db.prepare("INSERT INTO channels VALUES ('ch1', 'progetto-x', 'col-1', datetime('now'), 'bot')").run();
  db.prepare(
    "INSERT INTO topics (mm_channel_id, topic_slug, topic_display_name, outline_document_id) VALUES ('ch1', 't', 'T', 'doc-1')",
  ).run();
  db.prepare(
    `INSERT INTO saves (mm_channel_id, mm_post_id, mm_root_post_id, topic_id, triggered_by_user_id, triggered_by_username, status, payload_json)
     VALUES ('ch1', 'p1', 'r1', 1, 'u', 'user', 'success', '{}')`,
  ).run();
  db.prepare(
    "INSERT INTO document_chunks (doc_id, doc_title, doc_url, chunk_index, heading, content, embedding) VALUES ('doc-1', 'T', '/doc/t', 0, 'h', 'c', '[]')",
  ).run();
  db.prepare("INSERT INTO index_state (doc_id, doc_revision) VALUES ('doc-1', 3)").run();
  db.close();
}

describe("migration 004 on a legacy database", () => {
  let close: (() => void) | undefined;
  afterAll(() => {
    close?.();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(file + suffix, { force: true });
  });

  it("keeps existing data, links the old collection and allows channels without one", async () => {
    seedLegacyDb(file);
    process.env.DB_PATH = file;
    const { db } = await import("../../src/db/index.js");
    close = () => db.close();

    const q = (sql: string) => db.prepare(sql).all() as Array<Record<string, unknown>>;

    // Rebuilding `channels` must not cascade-delete topics nor null saves.topic_id.
    expect(q("SELECT mm_channel_id, outline_collection_id FROM channels")).toEqual([
      { mm_channel_id: "ch1", outline_collection_id: "col-1" },
    ]);
    expect(q("SELECT id FROM topics")).toEqual([{ id: 1 }]);
    expect(q("SELECT topic_id FROM saves")).toEqual([{ topic_id: 1 }]);

    // The legacy one-to-one collection becomes a channel link.
    expect(q("SELECT mm_channel_id, outline_collection_id FROM channel_collections")).toEqual([
      { mm_channel_id: "ch1", outline_collection_id: "col-1" },
    ]);

    // Chunks indexed without collection_id are scheduled for re-indexing.
    expect(q("SELECT * FROM index_state")).toEqual([]);

    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);

    // Channels can now exist without a dedicated collection, and share one.
    db.prepare("INSERT INTO channels (mm_channel_id, mm_channel_name, outline_collection_id, created_by_user_id) VALUES ('ch2', 'dm', NULL, 'bot')").run();
    db.prepare("INSERT INTO channels (mm_channel_id, mm_channel_name, outline_collection_id, created_by_user_id) VALUES ('ch3', 'y', 'col-1', 'bot')").run();
    expect(q("SELECT COUNT(*) AS n FROM channels")).toEqual([{ n: 3 }]);
  });
});
