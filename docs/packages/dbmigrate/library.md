---
title: Library — dbmigrate
description: Load SQL files and call Up, Rollback, Baseline from Go.
---

# Library

The `dbmigrate` CLI is a thin wrapper around a Go API. Everything the CLI does — apply, rollback, baseline, status, history — you can call directly from Go code. The most common reasons to do this are:

- **Tests.** You want to run your real migration files against an in-memory database before each test suite, without a separate CLI invocation.
- **Embedded binaries.** You want to ship the SQL files inside the binary itself using `embed.FS`, so there is no external folder to manage at runtime.
- **Operators and scripts.** A small Go program that manages a database lifecycle without invoking a subprocess.

The CLI and the library are the same engine. There is no difference in behaviour.

---

## Minimal example

```go
import (
    "context"

    "github.com/gomakenow/go-dbmigrate"
    "github.com/gomakenow/go-dbmigrate/postgres"
)

// 1. Load .up.sql / .down.sql pairs from a directory on disk.
migs, err := dbmigrate.LoadPath("db/migrations")
if err != nil {
    return err
}

// 2. Open a database connection using the driver package.
db, err := postgres.Open("postgres://user:pass@localhost:5432/myapp?sslmode=disable")
if err != nil {
    return err
}
defer db.Close()

// 3. Create a Migrator. Pass the db, the dialect, and the tracking table name.
//    Empty string uses the default: "dbmigrate_migrations".
m := dbmigrate.New(db, postgres.Dialect(), "")

// 4. Apply pending migrations.
if err := m.Up(context.Background(), migs); err != nil {
    return err
}
```

SQLite is the same shape — swap in `sqlite.Open` and `sqlite.Dialect()`.

---

## Loading migration files

Before you can call any `Migrator` method you need a `[]Migration` slice. Three functions produce one:

| Function | When to use it |
|---|---|
| `LoadPath(dir string)` | The standard case — a single directory on disk, sorted alphabetically by name |
| `LoadPaths(dirs []string)` | Multiple directories. Files from the first dir come first, then the second, and so on |
| `Load(fsys fs.FS, dir string)` | Same as `LoadPath` but reads from any `fs.FS`, including an `embed.FS` inside your binary |

A few rules the loader enforces:

- A `.down.sql` file without a matching `.up.sql` is an error.
- An `.up.sql` without a `.down.sql` is allowed — `HasDown` is `false` on that migration. Rollback will fail for that name if it ever comes up, but `up` does not care.
- Duplicate base names across directories are an error. If two packages both ship `20260101_000000_create_users`, rename one.
- The checksum stored on each `Migration` is SHA-256 of the **up** bytes only.

---

## Migrator methods

```go
m := dbmigrate.New(db, dialect, tableName)
```

`tableName` defaults to `"dbmigrate_migrations"` when left empty.

| Method | What it does |
|---|---|
| `m.Up(ctx, migs)` | Apply all pending files as one new batch |
| `m.Rollback(ctx, migs, steps)` | Undo the last `steps` batches, newest file first. `steps ≤ 0` means 1 |
| `m.Reset(ctx, migs)` | Roll back every batch — leaves the schema empty |
| `m.Refresh(ctx, migs)` | Reset, then Up — wipes and reapplies everything |
| `m.Fresh(ctx, migs, schema)` | Drop all user-owned tables, then Up. `schema` is used on Postgres (`"public"` is the typical value) |
| `m.Baseline(ctx, migs, lastFile)` | Record pending files as applied without running the SQL. Empty `lastFile` baselines every pending file |
| `m.Status(ctx, migs)` | Returns pending migration names in load order |
| `m.History(ctx)` | Returns every applied row: name, batch number, applied\_at |

`Up`, `Rollback`, `Baseline`, and `Fresh` acquire the dialect-level lock before doing any work, so two concurrent callers cannot interleave.

---

## Embedding SQL files in the binary

If you want to ship migration files inside the compiled binary — useful for self-contained CLIs or operators that manage their own database — use `embed.FS`:

```go
import "embed"

//go:embed db/migrations/*.sql
var migrationFS embed.FS

migs, err := dbmigrate.Load(migrationFS, "db/migrations")
if err != nil {
    return err
}

m := dbmigrate.New(db, postgres.Dialect(), "")
if err := m.Up(context.Background(), migs); err != nil {
    return err
}
```

The embedded path passed to `Load` must match the path you used in `//go:embed`. Everything else is the same as reading from disk. Your CI pipeline and local developer workflow can still run the CLI against the same files — the SQL source is identical.

---

## Multiple directories

Some projects keep migrations in more than one place — a core set of application tables and a separate set owned by a third-party package you are integrating:

```go
migs, err := dbmigrate.LoadPaths([]string{
    "db/migrations",
    "vendor/billing/migrations",
})
```

`LoadPaths` applies directory order: all files from the first directory (sorted by name) come before all files from the second. This means the core migrations always run first, then the billing ones. Names must still be globally unique across all directories — timestamps alone are not enough if two directories happen to generate the same stamp.

The CLI equivalent is repeating `--dir`:

```sh
dbmigrate up --dsn postgres://... --dir db/migrations --dir vendor/billing/migrations
```
