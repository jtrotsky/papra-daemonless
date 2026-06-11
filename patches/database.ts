// FreeBSD daemonless patch for Papra's database setup.
//
// WHY: Upstream uses `@libsql/client` whose `file:` driver loads the native
// `libsql` npm package. That package only ships prebuilt binaries for
// linux/darwin/win32 (see pnpm-lock.yaml: @libsql/{linux,darwin,win32}-* only,
// no freebsd), and the Rust source does not build cleanly under FreeBSD pkg.
// Critically, even *importing* `@libsql/client` eagerly loads the native module
// and crashes on FreeBSD with `Cannot find module '@libsql/freebsd-x64'`.
//
// FIX: This image only ever uses a local `file:` SQLite database, so we replace
// the driver entirely with `better-sqlite3` (which compiles its bundled SQLite
// amalgamation from source via node-gyp on FreeBSD — no system SQLite, no libsql).
// `@libsql/client` is NOT imported at all, so nothing pulls the native libsql
// module. `drizzle-orm/better-sqlite3` speaks the same SQLite dialect, so all
// queries and migrations work unchanged.
//
// Two gaps remain between the two drivers, both polyfilled below:
//
// 1. `.batch()` — drizzle's better-sqlite3 driver has no `.batch()` method (that
//    is a libsql-only API). Papra uses `db.batch([...])` in migrations and a
//    couple of runtime repositories. We polyfill it by running the queued
//    statements inside a single synchronous transaction, matching libsql's batch
//    semantics (all-or-nothing, results returned in order).
//
// 2. `db.run()` result SHAPE — libsql's `db.run(sql)` returns a ResultSet with
//    `.rows`/`.columns`/`.rowsAffected` for ANY statement (it always reads back
//    rows). better-sqlite3's drizzle `.run()` returns only `{changes,
//    lastInsertRowid}` with NO `.rows`. Papra reads `db.run(sql`PRAGMA
//    table_info(...)`).rows` in SEVEN migrations (0010/0011/0012/0014/0016/0017/
//    0019) and in the health-check repo. Rather than patch each call site, we
//    override `db.run` to return the libsql shape: for statements that return
//    data (PRAGMA/SELECT — `stmt.reader === true`) we `.all()` and populate
//    `.rows`; for DDL/DML we `.run()` and populate `.rowsAffected`. This makes the
//    libsql-shaped reads work everywhere unchanged.
//
// NOTE: remote libSQL/Turso URLs (DATABASE_URL=libsql://… or http(s)://…) are NOT
// supported in this FreeBSD image because the native libsql client can't load
// here. The container defaults to a local file DB, which is the standard self-host
// setup; pointing at a remote libSQL server would need a different base.

import type { ShutdownServices } from '../graceful-shutdown/graceful-shutdown.services';
import Database from 'better-sqlite3';
import { drizzle as drizzleBetterSqlite } from 'drizzle-orm/better-sqlite3';

export { setupDatabase };

// Convert a `file:./app-data/db/db.sqlite` style URL into a filesystem path that
// better-sqlite3 understands.
function fileUrlToPath(url: string): string {
  if (url === ':memory:' || url.startsWith(':memory:')) {
    return ':memory:';
  }

  let path = url.startsWith('file:') ? url.slice('file:'.length) : url;

  // Strip any query string (e.g. ?mode=rwc) — better-sqlite3 takes options separately.
  const queryIndex = path.indexOf('?');
  if (queryIndex !== -1) {
    path = path.slice(0, queryIndex);
  }

  return path;
}

// Polyfill libsql's `db.batch(queries)` for the better-sqlite3 driver.
//
// Subtlety: drizzle's better-sqlite3 driver is SYNCHRONOUS, so query objects
// behave differently depending on how they were created (Papra mixes both):
//   - `db.run(sql`...`)`  → executes EAGERLY during argument evaluation and
//     returns a plain RunResult ({changes,lastInsertRowid}) with no .run()/.all().
//     By the time batch() is called these statements have ALREADY run.
//   - `db.update(...)…` (a query builder, e.g. in the FTS repositories) → is LAZY;
//     it exposes .run()/.all() and has not executed yet.
//
// So we run any builder that still has a .run()/.all() method, and pass through
// already-executed results untouched. We wrap the whole thing in the RAW
// better-sqlite3 connection's `.transaction()` (which forwards its arguments to
// the wrapped fn, unlike drizzle's `db.transaction()` whose callback gets a tx
// object) so the lazy builders commit atomically. (The eagerly-run statements
// already auto-committed before we got here — atomicity across the eager ones is
// the one semantic we can't preserve, which is fine for Papra's idempotent,
// IF-NOT-EXISTS migrations and its result-discarding runtime write batches.)
function attachBatch(db: any, sqlite: any) {
  if (typeof db.batch === 'function') {
    return db;
  }

  const runInTransaction = sqlite.transaction((queries: any[]) => {
    const results: unknown[] = [];
    for (const query of queries) {
      // .run() works for any statement type (DDL/INSERT/UPDATE/DELETE and even
      // SELECT — it returns {changes,lastInsertRowid} without rows), whereas
      // .all() THROWS on non-SELECT. Papra's batched statements are all writes
      // whose return values are discarded, so prefer .run().
      if (typeof query?.run === 'function') {
        results.push(query.run());
      } else if (typeof query?.all === 'function') {
        results.push(query.all());
      } else {
        // Already-executed RunResult from an eager db.run(sql`...`); pass through.
        results.push(query);
      }
    }
    return results;
  });

  db.batch = async (queries: any[]) => runInTransaction(queries);

  return db;
}

// Override `db.run` to return libsql's ResultSet shape (see gap #2 above).
// drizzle's better-sqlite3 `.run()` drops rows for read statements, so libsql-era
// call sites that do `db.run(...).rows` break. We re-implement `run` against the
// raw better-sqlite3 connection: build the SQL string + params via drizzle's own
// dialect, then choose `.all()` (readers: PRAGMA/SELECT → populate `.rows`) vs
// `.run()` (writers/DDL → populate `.rowsAffected`). Returns synchronously; the
// `await db.run(...)` call sites resolve a plain value, which is fine.
function attachLibsqlRun(db: any, sqlite: any) {
  const dialect = db.dialect;

  db.run = (query: any) => {
    const { sql: queryString, params } = typeof query === 'string'
      ? { sql: query, params: [] as unknown[] }
      : dialect.sqlToQuery(query.getSQL());

    const stmt = sqlite.prepare(queryString);
    if (stmt.reader) {
      return {
        rows: stmt.all(...params),
        columns: stmt.columns().map((c: any) => c.name),
        rowsAffected: 0,
        changes: 0,
        lastInsertRowid: 0,
      };
    }

    const info = stmt.run(...params);
    return {
      rows: [],
      columns: [],
      rowsAffected: info.changes,
      changes: info.changes,
      lastInsertRowid: info.lastInsertRowid,
    };
  };

  return db;
}

function setupDatabase({
  url,
  // authToken/encryptionKey are libsql-only; ignored in the better-sqlite3 path.
  authToken: _authToken,
  encryptionKey: _encryptionKey,
  shutdownServices,
}: {
  url: string;
  authToken?: string;
  encryptionKey?: string;
  shutdownServices?: ShutdownServices;
}) {
  const path = fileUrlToPath(url);
  const sqlite = new Database(path);

  // Pragmas matching libsql's sensible defaults for a local single-writer file DB.
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');

  const db = attachBatch(attachLibsqlRun(drizzleBetterSqlite(sqlite), sqlite), sqlite);

  shutdownServices?.registerShutdownHandler({
    id: 'database-client-close',
    handler: () => {
      sqlite.close();
    },
  });

  return {
    db,
    client: sqlite,
  };
}
