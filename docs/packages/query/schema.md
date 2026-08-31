---
title: Schema — Query
description: Full reference for Schema options, Field options, operators, and kinds.
---

# Schema

Security by default: the package will **never** sort, filter, or search a column unless you explicitly declare it in `Schema()`. A client can only interact with columns listed in `Schema.Fields` — anything not declared simply doesn't exist to the outside world, even if it exists in the database.

---

## Schema options

`Schema` is the top-level configuration for your list. `Table` is the only required field — everything else has a sensible default you can override.

| Field | Default | Description |
|---|---|---|
| `Table` | — | **Required.** The database table name. The package qualifies every SQL column with this name (`users.name`, `users.created_at`) to avoid ambiguity, especially when joining other tables. |
| `IDKind` | `IDInt64` | The type of your table's primary key (`id` column). Used to correctly encode and decode the pagination cursor. Set `IDInt64` for `bigint` / `serial` PKs, `IDUUID` for `uuid` PKs. |
| `DefaultSort` | — | The sort applied when the client doesn't send `sort_by` and `sort_order`. `By` must be the `Name` of a field that has `Sort: true`. If not set, results come back in whatever order the database returns them. |
| `DefaultLimit` | `10` | How many rows to return per page when the client doesn't send `limit`. |
| `MinLimit` | `10` | The smallest page size a client may request. Requests below this are clamped up automatically. |
| `MaxLimit` | `100` | The largest page size a client may request. Requests above this are clamped down automatically. |

::: tip IDKind and your primary key
`IDKind` only affects how the pagination cursor is encoded — specifically, how the last row's `id` is stored so the package can fetch the next page correctly. It has nothing to do with foreign keys or other columns.

Set it to match your table's `id` column type:
- `query.IDInt64` — if `id` is `bigint`, `integer`, or `serial`
- `query.IDUUID` — if `id` is `uuid`
:::

---

## Field options

Each entry in `Fields` declares one queryable column.

The `Name` you give it serves two purposes at the same time: it becomes the URL parameter prefix the client uses (`name_eq=`, `created_at_gte=`), and it's also the SQL column name the package writes into the query (`users.name`, `users.created_at`). Because of this double role, **`Name` must exactly match your database column name**.

```go
// Example — a Field for each common situation:
Fields: []query.Field{
    // Basic sortable + filterable date column
    {Name: "created_at", Kind: query.KindTime, Sort: true, Filter: []string{query.OpGte, query.OpLte}},

    // String column with search and exact-match filter
    {Name: "name", Kind: query.KindString, Sort: true, Filter: []string{query.OpEq, query.OpNeq}, Search: true},

    // Nullable column — enables ?status_eq=null → IS NULL
    {Name: "deleted_at", Kind: query.KindTime, Filter: []string{query.OpEq, query.OpNeq}, Nullable: true},

    // Column from a JOINed table (not the main Schema.Table)
    {Name: "role", Kind: query.KindString, Filter: []string{query.OpEq}, Table: "user_roles"},
},
```

| Option | Type | Description |
|---|---|---|
| `Name` | `string` | **Required.** The database column name. Also the URL param prefix (`name_eq=`, `name_gte=`). Must match the column name exactly. |
| `Kind` | `Kind` | Required when `Sort` or `Filter` is set. Tells the package how to parse incoming filter values and how to encode this column's value in the pagination cursor. See [Kind values](#kind-values) below. |
| `Sort` | `bool` | When `true`, the client can sort by this column using `?sort_by=this_field`. |
| `Filter` | `[]string` | The operators the client is allowed to use on this column (e.g. `[]string{query.OpEq, query.OpGte}`). An empty slice means the column cannot be filtered at all. |
| `Search` | `bool` | When `true`, this column is included in `?search=` queries. The package does a case-insensitive substring match (`ILIKE '%term%'`) on all `Search: true` columns and returns a row if any one of them matches. |
| `Nullable` | `bool` | Set this to `true` when the database column can hold `NULL`. This unlocks two things: (1) `?field_eq=null` becomes `IS NULL` in SQL, and (2) sorting on this column correctly places `NULL` values at the top or bottom (`NULLS FIRST` / `NULLS LAST`). Without this, null filtering won't work correctly. |
| `Table` | `string` | Overrides which SQL table this column belongs to. By default the package uses `Schema.Table`, but when a column comes from a JOINed table you need to set this to the correct table name (e.g. `Table: "users"` on an orders list that joins the users table). |
| `Source` | `string` | The Go struct field name, when it differs from `Name`. This comes up with JOIN aliases: if your SQL returns `users.name AS user_name`, the column arrives as `user_name` but you need to map it to a Go field called `UserName`. Set `Name: "name"` (for SQL and URL) and `Source: "UserName"` (for the Go struct). |
| `JSON` | `bool` | Set to `true` when `Name` is a dotted path into a Postgres `jsonb` column. For example, `Name: "meta.plan"` with `JSON: true` generates `meta->>'plan'` in SQL, which reads the `plan` key out of the `meta` JSON column. |

---

## Operators

Operators are the suffixes the client appends to a field name in the URL (e.g. `name_eq=`, `created_at_gte=`). You control which operators are allowed per field by putting the corresponding constants in the field's `Filter` slice.

| Constant | URL suffix | SQL generated | Plain English |
|---|---|---|---|
| `query.OpEq` | `_eq` | `= 'value'` (or `IS NULL` when value is `"null"`) | equals |
| `query.OpNeq` | `_neq` | `!= 'value'` (or `IS NOT NULL`) | does not equal |
| `query.OpGt` | `_gt` | `> value` | greater than |
| `query.OpGte` | `_gte` | `>= value` | greater than or equal to |
| `query.OpLt` | `_lt` | `< value` | less than |
| `query.OpLte` | `_lte` | `<= value` | less than or equal to |

For example, if you declare `Filter: []string{query.OpGte, query.OpLte}` on `created_at`, the client may send `?created_at_gte=...` and `?created_at_lte=...`. Sending `?created_at_eq=...` would be rejected with a **400 Bad Request** because `eq` is not in the allowed list.

---

## Kind values

`Kind` tells the package two things: how to **parse** a filter value coming from the URL (e.g. should `"2025-01-01"` be treated as a string or a timestamp?), and how to **store** a column's value inside the pagination cursor so the next page starts from the correct position.

Match `Kind` to your Postgres column type:

| Constant | Use for Postgres type | How filter values are parsed |
|---|---|---|
| `query.KindString` | `varchar`, `text`, `char` | Used as-is — no parsing needed |
| `query.KindTime` | `timestamptz`, `timestamp` | Parsed as RFC3339 (`2025-01-01T00:00:00Z`) |
| `query.KindInt` | `integer`, `bigint`, `smallint`, `serial` | Parsed as a whole number |
| `query.KindFloat` | `float`, `double precision`, `numeric` | Parsed as a decimal number |
| `query.KindBool` | `boolean` | Value must be the string `"true"` or `"false"` |

::: warning Using the wrong Kind
If `Kind` doesn't match the actual column type, filter values will be parsed incorrectly and cursors will break. For example, declaring `KindString` on a `timestamptz` column will cause date range filters to silently produce wrong results.
:::
