---
title: Schema — Query
description: Full reference for Schema options, Field options, operators, and kinds.
---

# Schema

The `Schema` is an allow-list. The package never inspects your GORM model to decide what's queryable — it only knows what you explicitly declare here. This keeps filtering and sorting safe by default: anything not declared simply doesn't exist to the client.

---

## Schema options

`Table` is the only required field. Everything else has a sensible default.

| Field | Default | Description |
|---|---|---|
| `Table` | — | **Required.** SQL table name used to qualify all columns (`users.created_at`, `users.id`). |
| `IDKind` | `IDInt64` | Primary key type used for the cursor tie-breaker. Set to `IDUUID` if your table's PK is a UUID. |
| `DefaultSort` | — | Fallback sort when the client omits `sort_by`. `By` must name a field with `Sort: true`. |
| `DefaultLimit` | `10` | Rows per page when `limit` is omitted. |
| `MinLimit` | `10` | Minimum `limit` the client may request. |
| `MaxLimit` | `100` | Maximum `limit` the client may request. |

::: tip IDKind is about the cursor, not your model
`IDKind` tells the package how to encode and decode the cursor tie-breaker. Set it to match the primary key type of the table you're listing — `IDInt64` for `bigint`, `IDUUID` for `uuid`.
:::

---

## Field options

Each `Field` in the `Fields` slice declares one column. The `Name` you choose serves double duty: it becomes the URL parameter prefix (`name_eq=`, `name_gte=`) **and** the SQL column name (`users.name`). They need to match, so keep `Name` equal to your actual column name in the database.

`Kind` is required whenever `Sort` or `Filter` is set — it tells the package how to format that column's value in the cursor and how to parse filter values for comparison.

| Option | Type | Description |
|---|---|---|
| `Name` | `string` | **Required.** URL param prefix and SQL column. Must match the database column name. |
| `Kind` | `Kind` | Required when `Sort` or `Filter` is set. Controls cursor encoding and value parsing. |
| `Sort` | `bool` | Allow `sort_by=this_field`. |
| `Filter` | `[]string` | Operators the client may use on this column. Empty = not filterable. |
| `Search` | `bool` | Include in `?search=` full-text queries (`ILIKE` on Postgres). |
| `Nullable` | `bool` | Mark columns that can be SQL NULL. Enables `?name_eq=null` → `IS NULL` and correct `NULLS FIRST/LAST` sort behavior. |
| `Table` | `string` | Override the SQL table for this column. Use when the column lives on a joined table, not `Schema.Table`. |
| `Source` | `string` | Go struct field name when it doesn't match `Name`. Needed for join aliases like `AS user_name` → `Source: "UserName"`. |
| `JSON` | `bool` | `Name` is a dotted jsonb path. `"meta.key"` expands to `meta->>'key'` in SQL. |

---

## Operators

These are the strings you put in a field's `Filter` slice, and what the client sends in the URL:

| Constant | URL param | SQL |
|---|---|---|
| `query.OpEq` | `name_eq=alice` | `= 'alice'` (or `IS NULL` when value is `"null"`) |
| `query.OpNeq` | `name_neq=alice` | `!= 'alice'` (or `IS NOT NULL`) |
| `query.OpGt` | `created_at_gt=...` | `>` |
| `query.OpGte` | `created_at_gte=...` | `>=` |
| `query.OpLt` | `created_at_lt=...` | `<` |
| `query.OpLte` | `created_at_lte=...` | `<=` |

---

## Kind values

`Kind` controls how a column's value is encoded in the cursor and compared in filters.

| Constant | Postgres type | Cursor format |
|---|---|---|
| `query.KindString` | `varchar`, `text` | as-is |
| `query.KindTime` | `timestamptz` | RFC3339 |
| `query.KindInt` | `integer`, `bigint` | decimal string |
| `query.KindFloat` | `float`, `double precision` | decimal string |
| `query.KindBool` | `boolean` | `"true"` / `"false"` |
