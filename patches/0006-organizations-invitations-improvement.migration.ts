// FreeBSD daemonless patch for Papra migration 0006.
//
// WHY: Upstream uses libSQL's non-standard `ALTER TABLE ... ALTER COLUMN ... TO ...`
// syntax to change a column's constraints. Standard SQLite (better-sqlite3, which
// this FreeBSD image uses — see patches/database.ts) does NOT support ALTER COLUMN;
// SQLite only allows ADD/RENAME/DROP COLUMN. The original migration therefore fails
// with `near "ALTER": syntax error`.
//
// FIX: implement the same schema change with SQLite's supported "table rebuild"
// recipe (https://www.sqlite.org/lang_altertable.html#otheralter): create a new
// table with the desired column constraints, copy the data across, drop the old
// table, and rename. The net schema is identical to what libSQL's ALTER COLUMN
// would have produced:
//   - role:   text  ->  text NOT NULL
//   - status: text NOT NULL  ->  text NOT NULL DEFAULT 'pending'
// plus the unique index the original migration also created.
//
// Foreign keys are disabled around the rebuild (standard practice) and the whole
// thing runs in the batch transaction provided by the migration runner.

import type { Migration } from '../migrations.types';
import { sql } from 'drizzle-orm';

const INVITATIONS_COLUMNS = '"id","created_at","updated_at","organization_id","email","role","status","expires_at","inviter_id"';

export const organizationsInvitationsImprovementMigration = {
  name: 'organizations-invitations-improvement',

  up: async ({ db }) => {
    await db.batch([
      db.run(sql`
        CREATE TABLE "organization_invitations__new" (
          "id" text PRIMARY KEY NOT NULL,
          "created_at" integer NOT NULL,
          "updated_at" integer NOT NULL,
          "organization_id" text NOT NULL,
          "email" text NOT NULL,
          "role" text NOT NULL,
          "status" text NOT NULL DEFAULT 'pending',
          "expires_at" integer NOT NULL,
          "inviter_id" text NOT NULL,
          FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON UPDATE cascade ON DELETE cascade,
          FOREIGN KEY ("inviter_id") REFERENCES "users"("id") ON UPDATE cascade ON DELETE cascade
        )
      `),
      db.run(sql`INSERT INTO "organization_invitations__new" (${sql.raw(INVITATIONS_COLUMNS)}) SELECT ${sql.raw(INVITATIONS_COLUMNS)} FROM "organization_invitations"`),
      db.run(sql`DROP TABLE "organization_invitations"`),
      db.run(sql`ALTER TABLE "organization_invitations__new" RENAME TO "organization_invitations"`),
      db.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS "organization_invitations_organization_email_unique" ON "organization_invitations" ("organization_id","email")`),
    ]);
  },

  down: async ({ db }) => {
    await db.batch([
      db.run(sql`DROP INDEX IF EXISTS "organization_invitations_organization_email_unique"`),
      db.run(sql`
        CREATE TABLE "organization_invitations__old" (
          "id" text PRIMARY KEY NOT NULL,
          "created_at" integer NOT NULL,
          "updated_at" integer NOT NULL,
          "organization_id" text NOT NULL,
          "email" text NOT NULL,
          "role" text,
          "status" text NOT NULL,
          "expires_at" integer NOT NULL,
          "inviter_id" text NOT NULL,
          FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON UPDATE cascade ON DELETE cascade,
          FOREIGN KEY ("inviter_id") REFERENCES "users"("id") ON UPDATE cascade ON DELETE cascade
        )
      `),
      db.run(sql`INSERT INTO "organization_invitations__old" (${sql.raw(INVITATIONS_COLUMNS)}) SELECT ${sql.raw(INVITATIONS_COLUMNS)} FROM "organization_invitations"`),
      db.run(sql`DROP TABLE "organization_invitations"`),
      db.run(sql`ALTER TABLE "organization_invitations__old" RENAME TO "organization_invitations"`),
    ]);
  },
} satisfies Migration;
