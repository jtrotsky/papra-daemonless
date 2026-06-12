// FreeBSD daemonless patch for Papra's DB health check.
//
// WHY: Upstream does `db.run(sql`SELECT 1`)` and inspects `result.rows[0]['1']`,
// which is the @libsql/client result shape. Our FreeBSD image swaps the local DB
// driver to better-sqlite3 (see patches/database.ts), whose drizzle `.run()` returns
// `{changes, lastInsertRowid}` with no `.rows`, so the upstream check would always
// report the database as unhealthy and make `/api/health` return HTTP 500.
//
// FIX: use `db.all()` which both the libsql and better-sqlite3 drizzle drivers
// support and which returns an array of row objects on both. We alias the column to
// a stable name so the check is driver-independent.

import type { Database } from '../database/database.types';
import { safely } from '@corentinth/chisels';
import { sql } from 'drizzle-orm';

export async function isDatabaseHealthy({ db }: { db: Database }) {
  const [rows, error] = await safely((db as any).all(sql`SELECT 1 AS ok;`));

  return error === null && Array.isArray(rows) && rows.length > 0 && Number(rows[0]?.ok) === 1;
}
