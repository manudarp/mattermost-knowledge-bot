import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";

/**
 * Thin typed layer over Node's built-in SQLite (`node:sqlite`).
 *
 * Node ships and patches SQLite itself, so the bot has no native npm
 * dependency to compile or keep up to date. The API mirrors the subset of
 * better-sqlite3 the code base uses: typed prepared statements, `pragma()`
 * and `transaction()` wrappers.
 */

/** node:sqlite rejects undefined and booleans; map them like better-sqlite3 users expect. */
function bind(params: readonly unknown[]): SQLInputValue[] {
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === "boolean") return p ? 1 : 0;
    return p as SQLInputValue;
  });
}

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export class Statement<P extends readonly unknown[] = unknown[], R = unknown> {
  constructor(private readonly stmt: StatementSync) {}

  run(...params: P): RunResult {
    const r = this.stmt.run(...bind(params));
    return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
  }

  get(...params: P): R | undefined {
    return this.stmt.get(...bind(params)) as R | undefined;
  }

  all(...params: P): R[] {
    return this.stmt.all(...bind(params)) as R[];
  }
}

export class Database {
  private readonly raw: DatabaseSync;
  private txDepth = 0;

  constructor(path: string) {
    this.raw = new DatabaseSync(path);
  }

  prepare<P extends readonly unknown[] = unknown[], R = unknown>(sql: string): Statement<P, R> {
    return new Statement<P, R>(this.raw.prepare(sql));
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  /** `pragma("foreign_keys = ON")`; with `{ simple: true }` returns the first column of the first row. */
  pragma(source: string, opts: { simple?: boolean } = {}): unknown {
    const rows = this.raw.prepare(`PRAGMA ${source}`).all() as Array<Record<string, unknown>>;
    if (!opts.simple) return rows;
    const first = rows[0];
    return first ? Object.values(first)[0] : undefined;
  }

  /**
   * Wraps `fn` in a transaction (a SAVEPOINT when nested). Commits on return,
   * rolls back and rethrows on error.
   */
  transaction<A extends unknown[], T>(fn: (...args: A) => T): (...args: A) => T {
    return (...args: A): T => {
      const savepoint = `sp_${this.txDepth}`;
      this.raw.exec(this.txDepth === 0 ? "BEGIN" : `SAVEPOINT ${savepoint}`);
      this.txDepth++;
      try {
        const result = fn(...args);
        this.txDepth--;
        this.raw.exec(this.txDepth === 0 ? "COMMIT" : `RELEASE ${savepoint}`);
        return result;
      } catch (err) {
        this.txDepth--;
        this.raw.exec(this.txDepth === 0 ? "ROLLBACK" : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
        throw err;
      }
    };
  }

  close(): void {
    this.raw.close();
  }
}
