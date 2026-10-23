import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * An in-memory SQLite database behind the D1 API surface the worker uses
 * (`prepare` → `bind` → `all`/`first`/`run`, plus `batch`). Every migration
 * under `migrations/` is applied, and foreign keys are enforced like on D1, so
 * tests exercise the real SQL instead of a string-matching fake.
 */
export function createSqliteD1(options: { migrations?: (name: string) => boolean } = {}): {
  db: D1Database;
  sqlite: Database;
} {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  const dir = join(import.meta.dir, "..", "migrations");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    if (options.migrations && !options.migrations(file)) continue;
    sqlite.exec(readFileSync(join(dir, file), "utf8"));
  }

  interface Stmt {
    sql: string;
    args: unknown[];
    bind: (...args: unknown[]) => Stmt;
    all: <T>() => Promise<{ results: T[]; success: true; meta: Record<string, unknown> }>;
    first: <T>(column?: string) => Promise<T | null>;
    run: () => Promise<{ success: true; meta: { changes: number; last_row_id: number } }>;
  }

  const normalize = (args: unknown[]): Array<string | number | null> =>
    args.map((a) =>
      a === undefined ? null : typeof a === "boolean" ? (a ? 1 : 0) : (a as string | number),
    );

  function execute(sql: string, args: unknown[]): { rows: unknown[]; changes: number; id: number } {
    const query = sqlite.query(sql);
    const bound = normalize(args);
    if (/^\s*(SELECT|WITH)/i.test(sql) || /\bRETURNING\b/i.test(sql)) {
      const rows = query.all(...bound);
      return { rows, changes: 0, id: 0 };
    }
    const result = query.run(...bound);
    return { rows: [], changes: result.changes, id: Number(result.lastInsertRowid) };
  }

  const prepare = (sql: string): Stmt => {
    const stmt: Stmt = {
      sql,
      args: [],
      bind(...args: unknown[]): Stmt {
        return { ...stmt, args };
      },
      async all<T>() {
        return { results: execute(sql, this.args).rows as T[], success: true, meta: {} };
      },
      async first<T>(column?: string) {
        const row = (execute(sql, this.args).rows[0] ?? null) as Record<string, unknown> | null;
        if (!row) return null;
        return (column ? row[column] : row) as T;
      },
      async run() {
        const r = execute(sql, this.args);
        return { success: true, meta: { changes: r.changes, last_row_id: r.id } };
      },
    };
    return stmt;
  };

  const db = {
    prepare,
    async batch(stmts: Stmt[]): Promise<unknown[]> {
      const results: unknown[] = [];
      sqlite.exec("BEGIN");
      try {
        for (const s of stmts) {
          const r = execute(s.sql, s.args);
          results.push({ results: r.rows, success: true, meta: { changes: r.changes } });
        }
        sqlite.exec("COMMIT");
      } catch (err) {
        sqlite.exec("ROLLBACK");
        throw err;
      }
      return results;
    },
    async exec(sql: string): Promise<{ count: number; duration: number }> {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
  };
  return { db: db as unknown as D1Database, sqlite };
}

/** A Map-backed KV namespace with the subset of the API the worker uses. */
export function createMemoryKV(): { kv: KVNamespace; store: Map<string, string> } {
  const store = new Map<string, string>();
  const kv = {
    async get(key: string, type?: string | { type?: string }): Promise<unknown> {
      const v = store.get(key);
      if (v == null) return null;
      const t = typeof type === "string" ? type : type?.type;
      return t === "json" ? JSON.parse(v) : v;
    },
    async put(key: string, value: string): Promise<void> {
      store.set(key, value);
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
    async list({ prefix = "" }: { prefix?: string } = {}): Promise<{
      keys: Array<{ name: string }>;
      list_complete: boolean;
    }> {
      return {
        keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
        list_complete: true,
      };
    },
  };
  return { kv: kv as unknown as KVNamespace, store };
}
