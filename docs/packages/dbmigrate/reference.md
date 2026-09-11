---
title: Reference — dbmigrate
description: CLI flags, tracking table, Migration struct, Migrator methods.
---

# Reference

Complete CLI flags, tracking-table schema, and library signatures for `go-dbmigrate`. For a walkthrough, start with [Getting started](./).

---

## Module

```
github.com/gomakenow/go-dbmigrate
github.com/gomakenow/go-dbmigrate/cmd/dbmigrate
github.com/gomakenow/go-dbmigrate/postgres
github.com/gomakenow/go-dbmigrate/sqlite
```

---

## File names

```
{YYYY_MM_DD_HHMMSS}_{slug}.up.sql
{YYYY_MM_DD_HHMMSS}_{slug}.down.sql
```

Example: `2026_03_19_153546_create_users_table`. The tracking `name` is that full base string (no `.up.sql`). Identity is the name, not a version integer.

---

## Tracking table

Default name: `dbmigrate_migrations`. Override with `--table` / the third argument to `New`.

| Column | Type | Notes |
|---|---|---|
| `name` | text | Primary key. Migration base name |
| `checksum` | text | SHA-256 hex of the up file bytes |
| `batch` | integer | Shared by every file applied in one `Up` |
| `applied_at` | timestamptz / datetime | Set by the database default |

---

## CLI

```
dbmigrate create <name> [--dir DIR]
dbmigrate check [--dir DIR]...
dbmigrate up --dsn DSN [--dir DIR]... [--table T] [--driver D]
dbmigrate rollback --dsn DSN [--step N] ...
dbmigrate status --dsn DSN ...
dbmigrate history --dsn DSN ...
dbmigrate baseline --dsn DSN [--last-file-to-apply NAME] [--yes] ...
dbmigrate reset --dsn DSN [--yes] ...
dbmigrate refresh --dsn DSN [--yes] ...
dbmigrate fresh --dsn DSN [--schema public] [--yes] ...
```

`--dsn` is required except on `create` and `check`.

`--dir` may be repeated. Default is `migrations`.

`--driver`: `postgres` or `sqlite`. Auto-detected from `--dsn` when possible.

`--yes` skips the confirmation prompt on `fresh` / `refresh` / `reset` / `baseline`.

---

## Migration

```go
type Migration struct {
    Name     string // e.g. "2026_03_19_153546_create_users_table"
    UpSQL    string
    DownSQL  string
    HasDown  bool
    Checksum string // sha256 of UpSQL
}
```

```go
func Load(fsys fs.FS, dir string) ([]Migration, error)
func LoadPath(dir string) ([]Migration, error)
func LoadPaths(dirs []string) ([]Migration, error)
```

---

## Migrator

```go
func New(db *sql.DB, dialect Dialect, tableName string) *Migrator

func (m *Migrator) Up(ctx context.Context, migrations []Migration) error
func (m *Migrator) Rollback(ctx context.Context, migrations []Migration, steps int) error
func (m *Migrator) Reset(ctx context.Context, migrations []Migration) error
func (m *Migrator) Refresh(ctx context.Context, migrations []Migration) error
func (m *Migrator) Fresh(ctx context.Context, migrations []Migration, schemaName string) error
func (m *Migrator) Baseline(ctx context.Context, migrations []Migration, lastFileToApply string) error
func (m *Migrator) Status(ctx context.Context, migrations []Migration) ([]string, error)
func (m *Migrator) History(ctx context.Context) ([]HistoryEntry, error)
```

```go
type HistoryEntry struct {
    Name      string
    Batch     int
    AppliedAt string
}
```

`Baseline` with a non-empty `lastFileToApply` stamps files through that name (load order, inclusive). Later files stay pending.

---

## Dialect

See [Drivers](./drivers) for the full interface and how Postgres / SQLite implement it.
