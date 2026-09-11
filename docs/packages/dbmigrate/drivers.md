---
title: Drivers — dbmigrate
description: Postgres and SQLite dialects, and how to add another database.
---

# Drivers

`go-dbmigrate` separates the migration engine from database specifics through a `Dialect` interface. The engine knows how to load files, track names, manage batches, and enforce checksums — but it has no hardcoded SQL for any particular database. Every database-specific detail (locking mechanism, identifier quoting, table listing for `fresh`, timestamp syntax) is the driver's job.

Two drivers ship in the module:

- **Postgres** — backed by `pgx/v5`, the most widely used Go Postgres driver.
- **SQLite** — backed by `modernc.org/sqlite`, a pure Go port with no CGO dependency. Works on any platform without a C toolchain.

Pick the one that matches your database, pass it into `dbmigrate.New`, and the engine does the rest.

---

## PostgreSQL

```go
import (
    "github.com/gomakenow/go-dbmigrate"
    "github.com/gomakenow/go-dbmigrate/postgres"
)

db, err := postgres.Open("postgres://user:pass@localhost:5432/myapp?sslmode=disable")
if err != nil {
    return err
}
defer db.Close()

m := dbmigrate.New(db, postgres.Dialect(), "")
```

`postgres.Open` returns a `*sql.DB` using `pgx` as the underlying driver. You can also bring your own connection — any `*sql.DB` backed by a Postgres driver works — and pass `postgres.Dialect()` separately.

### Locking

The Postgres dialect acquires a `pg_advisory_lock` on a dedicated connection at the start of every `Up`, `Rollback`, `Baseline`, or `Fresh` call. This means two processes running `up` against the same database at exactly the same time — two CI jobs on a busy pipeline, for example — cannot interleave. The second one waits until the first releases the lock, then runs with an up-to-date view of the tracking table.

### `fresh` and schemas

`fresh` queries `information_schema.tables` for the schema you pass (CLI flag `--schema`, default `public`) and drops every user table with `CASCADE`. It skips the tracking table itself so dbmigrate can recreate it cleanly after the wipe. If your tables live in a non-default schema, set `--schema` or pass the schema name to `m.Fresh`.

The CLI detects this driver automatically when the DSN starts with `postgres://` or `postgresql://`.

---

## SQLite

```go
import (
    "github.com/gomakenow/go-dbmigrate"
    "github.com/gomakenow/go-dbmigrate/sqlite"
)

db, err := sqlite.Open("file:./app.db")
if err != nil {
    return err
}
defer db.Close()

m := dbmigrate.New(db, sqlite.Dialect(), "")
```

Common DSN forms:

| DSN | What it opens |
|---|---|
| `file:./app.db` | Database file on disk, created if missing |
| `:memory:` | Ephemeral in-process database, gone when the connection closes |
| `file::memory:?cache=shared` | In-memory database shared across multiple connections in the same process — useful in tests that open more than one connection |

### Locking

SQLite has no advisory lock mechanism. The dialect sets a short exclusive lock at the start of a migration run using SQLite's built-in locking. This is sufficient for the typical SQLite use case (a single writer process), but if you have multiple processes writing to the same file concurrently, SQLite itself is the bottleneck long before dbmigrate is.

### `fresh`

The SQLite dialect queries `sqlite_master` for all user tables and drops them. It filters out `sqlite_*` system tables and skips the tracking table by name so it can be recreated cleanly. If you rename the tracking table with `--table`, make sure the name does not collide with an application table you want `fresh` to preserve.

The CLI detects this driver from DSNs starting with `file:`, equal to `:memory:`, or ending in `.db`, `.sqlite`, or `.sqlite3`.

---

## Adding a driver

If you need a database that is not Postgres or SQLite — MySQL, CockroachDB, a custom store — implement the `Dialect` interface in your own package and pass it into `dbmigrate.New`. You do not need to fork the module or touch the CLI.

```go
type Dialect interface {
    Name() string
    EnsureTableSQL(tableName string) string
    Lock(ctx context.Context, db *sql.DB) (release func() error, err error)
    ListTablesSQL() string
    DropTableSQL(schema, table string) string
    TimestampDefault() string
    QuoteIdentifier(s string) string
}
```

What each method needs to do:

| Method | Requirements |
|---|---|
| `Name()` | A short lowercase label — `"postgres"`, `"mysql"`. Used in logs and error messages |
| `EnsureTableSQL(tableName)` | `CREATE TABLE IF NOT EXISTS` with columns `name` (PK text), `checksum` (text), `batch` (int), `applied_at` (timestamp). The engine calls this once on startup |
| `Lock(ctx, db)` | Acquire an exclusive lock that prevents concurrent `Up` / `Rollback` / `Baseline` / `Fresh` runs. Return a `release` function that is safe to call even if `ctx` is already cancelled |
| `ListTablesSQL()` | A query returning one column of user table names, for use by `Fresh`. Return an empty string if your database cannot support `Fresh` — the engine will refuse `fresh` calls rather than panic |
| `DropTableSQL(schema, table)` | DDL to drop a single table. `schema` may be an empty string if your database has no schema concept |
| `TimestampDefault()` | A SQL expression for the `applied_at` column default, e.g. `now()` or `CURRENT_TIMESTAMP` |
| `QuoteIdentifier(s)` | Safely quote an identifier so a custom `--table` name cannot inject SQL — e.g. wrap in double quotes and escape inner quotes |

::: warning Placeholder style
The tracking table inserts use `$1, $2, $3` positional placeholders (compatible with both Postgres and SQLite via `modernc`). If your database requires a different style — `?` for MySQL, for example — that would need a small change in the engine's insert statement. The two shipped dialects both accept the `$N` form.
:::

To wire your driver into the CLI, add a detection case alongside `postgres` and `sqlite` in `cmd/dbmigrate/main.go`. For an application binary that never uses the CLI, calling `dbmigrate.New(db, yourDialect, "")` is all you need.
