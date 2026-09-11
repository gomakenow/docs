---
title: DBmigrate
description: Laravel-style SQL migrations for Go. Name-keyed tracking, batches, checksums. Postgres and SQLite.
---

# DBmigrate

Every Go app that uses a relational database faces the same unglamorous problem: the schema has to be the same on every machine, and it has to get there in the right order, reliably, every time. Your laptop, a new teammate's laptop, CI, staging, production — all of them need to run the same set of changes, and none of them should run a change twice.

Without a tool for this, it falls apart fast. Someone types `ALTER TABLE users ADD COLUMN phone text` directly into `psql` on production at 11pm, then forgets to write the file. Three months later a new hire joins, clones the repo, and the app panics on startup because their local database is missing that column. Nobody knows how to reproduce what "current production" actually looks like from scratch. CI tries to run the same `CREATE INDEX` twice on a branch rebase and the pipeline dies. Two developers each add a "version 42" migration file and the merge conflict is ugly. The release notes say "run these two SQL files manually before deploying."

This is not a hypothetical. It is what happens on most projects that do not use a migration tool.

`go-dbmigrate` is the way out. You write every schema change as a pair of SQL files — `.up.sql` for the forward change, `.down.sql` to reverse it — and you commit them like any other code change. The tool keeps a table in your database recording which file names have already run. When you run `up` on any environment, it looks at that list, finds the files it has never seen, and applies only those. Production is not special. A fresh laptop is not special. They both walk the same list. And six months from now, when someone asks "did that index ever land on staging?", you check `dbmigrate history` and get a real answer.

There are three ideas that make this design work, and they are worth understanding before you start:

**The filename is the identity, not a version number.** Files are named with a UTC timestamp prefix — `2026_03_19_153546_create_users_table` — not "migration 001, 002, 003." Two developers can add migrations on separate branches at the same time. When the branches merge, both files exist in the folder. `up` applies whichever names the target database has not seen yet. The timestamps keep them sorted; they are not a strict monotonic counter that two people fight over.

**One `up` run is one batch.** If you run `up` on Monday and five new files apply, they all share batch number 4. `rollback` undoes that entire batch, last file first. You are not picking individual files to revert — you are undoing a deploy as a unit, the same way you would revert a git commit. This matters when a deploy has multiple related migrations that depend on each other.

**Applied SQL is frozen.** The first time `up` records a file, it stores a SHA-256 checksum of the up SQL alongside the name. If you go back and edit that file later, the next `up` will refuse — the checksum no longer matches. The rule is simple: add a new file, do not rewrite history. The tracking table becomes a genuine record of what actually ran on the database, not a document someone tidied up afterward.

```
Files in git
  migrations/2026_03_19_153546_create_users_table.up.sql
  migrations/2026_03_19_153546_create_users_table.down.sql
  migrations/2026_04_01_091200_add_users_phone.up.sql
  migrations/2026_04_01_091200_add_users_phone.down.sql

On every environment (laptop, CI, staging, production):
  dbmigrate up --dsn postgres://... --dir ./migrations
        │
        ├── take a db lock (two concurrent deploys cannot interleave)
        ├── check dbmigrate_migrations for already-seen names
        ├── run each new .up.sql in its own transaction
        └── record name + checksum + batch

Something went wrong on that deploy:
  dbmigrate rollback
        │
        └── undo the last batch, newest file first, using .down.sql
```

Most teams never import this from Go code. They install the CLI binary once and call it from a Makefile target or a CI step before the app boots. The same operations are available as a Go library if you want to run migrations inside a test setup or a small operator tool — it is the same engine underneath.

::: info What dbmigrate does not do
It does not generate GORM model structs, seed demo data, or run automatically when your HTTP server starts. It does not know or care about the rest of your codebase. You give it a folder of SQL files and a database URL. Everything else is yours.
:::

---

## Step 1 — Install the CLI

```sh
# Latest — fine for local development
go install github.com/gomakenow/go-dbmigrate/cmd/dbmigrate@latest

# Pinned version — recommended for CI and production
go install github.com/gomakenow/go-dbmigrate/cmd/dbmigrate@v1.0.0
```

Both give you the same `dbmigrate` binary. Use `@latest` locally when you want to stay current; pin a version in CI and production so every environment runs the identical binary and a new release never breaks a deploy unexpectedly.

If you want to call migrations from Go code instead of the CLI:

```sh
go get github.com/gomakenow/go-dbmigrate
```

---

## Step 2 — Create a migration file

```sh
dbmigrate create create_users_table --dir ./migrations
```

This writes two empty files with a UTC timestamp prefix — no database connection needed:

```
migrations/2026_03_19_153546_create_users_table.up.sql
migrations/2026_03_19_153546_create_users_table.down.sql
```

The timestamp is just there to keep files in chronological order when they sort alphabetically. The full base name — `2026_03_19_153546_create_users_table` — is what the tracking table actually stores. Two files cannot share the same full base name across any of the directories you point `up` at.

---

## Step 3 — Write the SQL

Put the forward change in `.up.sql` and the exact reversal in `.down.sql`. Down files are optional — `up` does not care — but you will want them when you need `rollback` or `refresh`, and both commands refuse to start if any targeted file is missing its down.

```sql
-- up: add the users table
CREATE TABLE users (
    id         bigserial PRIMARY KEY,
    email      text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now()
);
```

```sql
-- down: reverse the above
DROP TABLE IF EXISTS users;
```

::: warning Never edit an applied `.up.sql`
Once `up` has run a file and recorded its checksum, editing it causes the next `up` to stop with an error. If you need to change the schema further, add a new file — `add_users_phone`, `add_users_phone_index`, whatever describes the next step. The already-applied file stays as a permanent record of what actually happened.
:::

---

## Step 4 — Apply

Point `up` at your database. The driver is detected automatically from the connection string:

```sh
# Postgres
dbmigrate up \
  --dsn "postgres://user:pass@localhost:5432/myapp?sslmode=disable" \
  --dir ./migrations

# SQLite
dbmigrate up --dsn file:./dev.db --dir ./migrations
```

The first time you run this, `up` creates a small tracking table called `dbmigrate_migrations` in your database — one row per applied file, storing the file's base name, a SHA-256 checksum of the SQL, the batch number it ran in, and the timestamp. This table is the source of truth for everything `up`, `rollback`, `status`, and `history` do. You never write to it yourself; dbmigrate owns it entirely.

If that name collides with something in your schema, or you just prefer a different one, pass `--table`:

```sh
dbmigrate up \
  --dsn "postgres://user:pass@localhost:5432/myapp?sslmode=disable" \
  --dir ./migrations \
  --table schema_migrations
```

Use the same `--table` on every command against that database. Mixing names means dbmigrate looks at an empty table and tries to apply files that already ran. From Go, pass the name as the third argument to `dbmigrate.New`.

With the table in place, every subsequent `up` — on any machine, at any time — checks that table first. It applies only the files whose names are not already there. Run it again with no new files and it prints `nothing to migrate`. Add two new migration files, run `up` again, and exactly those two apply as **batch 2**. The files from batch 1 are untouched.

Once you have applied a few migrations, two commands tell you what is going on:

```sh
# Shows each file and whether it is pending or applied.
# Useful before a deploy to confirm which migrations will run.
dbmigrate status --dsn postgres://... --dir ./migrations

# Shows every migration that has ever been applied, with its batch number
# and timestamp. Useful after a deploy to confirm what actually ran,
# or when debugging "did this change land on staging?"
dbmigrate history --dsn postgres://... --dir ./migrations
```

---

## What `up` actually does inside

It helps to know the exact sequence, because this is also how you reason about what went wrong when something fails:

1. Take a database-level lock so two concurrent `up` processes (two CI jobs, two developers) cannot interleave and corrupt the batch numbering.
2. Load every `*.up.sql` file from `--dir`, sorted alphabetically by name.
3. Read `dbmigrate_migrations` to find which names are already applied. If a recorded file's checksum no longer matches the file on disk, stop immediately — do not apply anything.
4. Assign a new batch number (`MAX(batch) + 1`) to everything that is pending.
5. For each pending file in order: open a transaction, run the SQL, insert the tracking row, commit. If the SQL fails, the transaction rolls back and that file is not recorded. The files that already succeeded in this run stay applied.

The result: if a migration fails halfway through a multi-file `up`, the successfully-applied files remain. The broken file does not appear in the tracking table. You fix the SQL, run `up` again, and only the broken file retries.

---

## What's next

| Page | What you'll find |
|---|---|
| [Commands](./commands) | Every command with examples — `rollback`, `baseline`, `fresh`, `reset`, `refresh` |
| [Library](./library) | Calling `Up`, `Rollback`, `Baseline` from Go code, using `embed.FS`, multiple dirs |
| [Drivers](./drivers) | Postgres and SQLite in detail, adding support for another database |
| [Reference](./reference) | All CLI flags, tracking table schema, full function signatures |
| [Testing](./testing) | Running real migration files against in-memory SQLite in Go tests |
