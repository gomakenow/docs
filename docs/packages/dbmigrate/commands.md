---
title: Commands — dbmigrate
description: up, rollback, baseline, fresh, reset, refresh, status, history, check. Batches and checksums.
---

# Commands

Once you have migrations on disk, you interact with them through a handful of commands. Most of your day-to-day usage will be just three: `create` to make a new file pair, `up` to apply what is pending, and `rollback` when a deploy needs to be reversed. The rest — `baseline`, `fresh`, `reset`, `refresh` — solve specific situations you will recognise when you hit them.

Every command except `create` and `check` requires `--dsn`. `--dir` defaults to `migrations`. The driver is inferred automatically from the connection string (`postgres://…` means Postgres, `file:` or `.db` means SQLite), so you rarely need `--driver` explicitly.

Flags that apply across most commands:

| Flag | Default | Notes |
|---|---|---|
| `--dsn` | (required) | Connection string |
| `--dir` | `migrations` | Repeatable. Names must be unique across all dirs you pass |
| `--table` | `dbmigrate_migrations` | Tracking table |
| `--driver` | auto | `postgres` or `sqlite` |
| `--schema` | `public` | Used by `fresh` on Postgres |
| `--yes` | off | Skip the type-`yes` prompt on destructive commands |

---

## create

```sh
dbmigrate create add_users_email --dir ./migrations
```

Writes `{UTC timestamp}_{name}.up.sql` and a matching `.down.sql`. No database connection.

Use a short snake_case slug: `add_users_email`, not a sentence. The timestamp is generated for you — do not invent one.

---

## check

```sh
dbmigrate check --dir ./migrations
```

Loads the files, rejects a down without an up, rejects duplicate names. Does not talk to the database. Useful in CI before `up`.

You can pass `--dir` more than once. Duplicate **base names** across folders fail — the tool will not silently pick one.

---

## up

Applies every file whose name is not yet in the tracking table. One successful `up` = one **batch**.

```sh
dbmigrate up --dsn postgres://user:pass@localhost:5432/app --dir ./migrations
```

If nothing is pending: `nothing to migrate`.

::: warning Checksums
If `create_users` is already applied and you change that `.up.sql` on disk, `up` errors. Create `add_users_phone` instead.
:::

---

## status and history

```sh
dbmigrate status  --dsn postgres://... --dir ./migrations
dbmigrate history --dsn postgres://... --dir ./migrations
```

`status` lists names that have not been applied, in load order.

`history` lists applied rows: batch number, name, `applied_at`.

---

## rollback

Undoes the last **batch** (default), not “the last file.” If Monday’s `up` applied three files together, one `rollback` undoes all three, newest name first.

```sh
dbmigrate rollback --dsn postgres://... --dir ./migrations
dbmigrate rollback --step 2 --dsn postgres://... --dir ./migrations
```

`--step N` undoes the last N batches.

Every file in those batches **must** have a `.down.sql`. If one does not, rollback stops **before** changing anything.

Each down runs in its own transaction: down SQL, then delete the tracking row.

---

## reset

Rolls back **every** batch and stops. Schema should match “never migrated,” aside from the empty tracking table. Needs downs on every applied file.

```sh
dbmigrate reset --dsn postgres://... --dir ./migrations --yes
```

Without `--yes`, the CLI asks you to type `yes`.

---

## refresh

`reset` then `up`. Needs downs on everything that was applied. You get a clean replay of the current files as a new batch 1.

```sh
dbmigrate refresh --dsn postgres://... --dir ./migrations --yes
```

---

## fresh

Drops user tables **directly** (no down SQL) and runs every migration from scratch as batch 1.

Postgres: lists tables in `--schema` (default `public`) and `DROP TABLE … CASCADE`.

SQLite: drops application tables (skips `sqlite_*` internals).

```sh
dbmigrate fresh --dsn postgres://... --dir ./migrations --schema public --yes
```

::: danger fresh destroys data
There is no undo except restoring a backup. Use it on empty or disposable databases.
:::

---

## baseline

Records pending names and checksums **without running SQL**. Use this when the database **already has** the schema those files describe — you switched tools, or you adopted dbmigrate on a live database.

```sh
# Stamp every pending file as applied
dbmigrate baseline --dsn postgres://... --dir ./migrations --yes

# Stamp only through this name (inclusive). Later files stay pending for up.
dbmigrate baseline --dsn postgres://... --dir ./migrations \
  --last-file-to-apply 2026_03_20_100000_add_users_email --yes
```

`--lastFileToApply` is the same flag. You can pass a base name, a `.up.sql` filename, or a path basename.

::: warning Only baseline what is already in the database
If you baseline a file whose SQL was never applied, the next `up` will skip it forever and your schema will be missing that change. Confirm the live schema matches those files first.
:::

---

## Batches, in one picture

You run `up` on Monday. Three new files apply. They all get `batch = 1`.

You run `up` on Tuesday. Two more files. They get `batch = 2`.

`rollback` with default `--step 1` undoes Tuesday only.

That is why “one deploy = one `up`” is a good habit: rollback of that deploy is one command.

---

## Concurrent runs

Postgres takes an advisory lock so two `up` processes cannot interleave.

SQLite serializes the start of a run with a short exclusive lock. Do not point two writers at the same file if you can avoid it.
