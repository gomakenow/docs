---
title: Query string — Query
description: URL parameters for sorting, filtering, searching, and cursor pagination.
---

# Query string

Once you've declared your [Schema](./schema), the frontend controls the list entirely through URL query params — no extra handler code is needed. The package reads `r.URL.Query()`, validates every param against your Schema, and translates it into SQL automatically.

---

## Sorting

Use `sort_by` to pick a column and `sort_order` to pick a direction. The column name must match a field you declared with `Sort: true` in your Schema — anything else is rejected with a **400 Bad Request**.

Sort by name, A → Z:

```
?sort_by=name&sort_order=asc
```
```sql
ORDER BY users.name ASC, users.id ASC
```

Sort by sign-up date, newest first. When `sort_order` is omitted it falls back to `DefaultSort`:

```
?sort_by=created_at
```
```sql
ORDER BY users.created_at DESC, users.id DESC
```

::: tip Why is `users.id` always added?
Two rows can share the same `created_at` timestamp. Without a tie-breaker, those rows could appear in a different order on the next page — or appear twice. Appending `id` makes every page stable and deterministic.
:::

---

## Filtering

Every filter param follows the pattern `{column}_{operator}=value`, where `{column}` is the `Name` of a field in your Schema and `{operator}` is one of the operators you listed in that field's `Filter` slice. The package rejects anything that isn't declared — unknown columns and disallowed operators both return **400 Bad Request**.

Match an exact value (`eq` = equals):

```
?name_eq=morgan
```
```sql
WHERE users.name = 'morgan'
```

Exclude a value (`neq` = not equals):

```
?name_neq=morgan
```
```sql
WHERE users.name != 'morgan'
```

Range filter — `gte` means "greater than or equal to":

```
?created_at_gte=2025-01-01T00:00:00Z
```
```sql
WHERE users.created_at >= '2025-01-01T00:00:00Z'
```

You can combine as many filters as you need — they are all ANDed together, meaning every condition must be true for a row to be included:

```
?name_eq=morgan&created_at_gte=2025-01-01T00:00:00Z
```
```sql
WHERE users.name = 'morgan' AND users.created_at >= '2025-01-01T00:00:00Z'
```

To filter for rows where a column is `NULL`, pass the string `null` as the value. The field must have `Nullable: true` in its Schema declaration, otherwise the package doesn't know the column can be null:

```
?banned_at_eq=null
```
```sql
WHERE users.banned_at IS NULL
```

```
?banned_at_neq=null
```
```sql
WHERE users.banned_at IS NOT NULL
```

---

## Search

`?search=` does a **case-insensitive substring match** — it finds any row where the search term appears anywhere inside the value, regardless of capitalisation. Only fields marked `Search: true` in the Schema are included. The package queries all of them at once and returns a row if the term matches in **any one** of those columns.

**One searchable column**

The Schema declares only `name` as searchable:

```go
// Schema.Fields
Fields: []query.Field{
    {Name: "name", Kind: query.KindString, Search: true},  // included in search
    {Name: "role", Kind: query.KindString},                // no Search: true — skipped
},
```

```
?search=morgan
```
```sql
WHERE users.name ILIKE '%morgan%'
-- ILIKE is Postgres's case-insensitive LIKE — matches "Morgan", "MORGAN", "morgan", etc.
```

**Multiple searchable columns**

The Schema declares both `name` and `email` as searchable:

```go
// Schema.Fields
Fields: []query.Field{
    {Name: "name",  Kind: query.KindString, Search: true}, // included in search
    {Name: "email", Kind: query.KindString, Search: true}, // included in search
    {Name: "role",  Kind: query.KindString},               // no Search: true — skipped
},
```

```
?search=morgan
```
```sql
WHERE (users.name ILIKE '%morgan%' OR users.email ILIKE '%morgan%')
```

A user named "Morgan" and a user with email "morgan@example.com" would both be returned, even if only one of the columns matches.

---

## Pagination

This package uses **cursor-based pagination**, which is different from the classic `?page=1`, `?page=2` approach you may have seen before.

Instead of a page number, the response gives you a _cursor_ — a reference to the last row you received. You send that cursor back on the next request to get the rows that come after it. This makes pagination stable even when rows are being added or deleted between requests.

**First request — no cursor needed**

```
?limit=20
```

The response includes a `pagination` object:

```json
{
  "data": [...],
  "pagination": {
    "limit": 20,
    "total": 142,
    "has_next": true,
    "next_cursor": {
      "id": 42,
      "value": "2025-01-01T00:00:00Z",
      "limit": 20
    }
  }
}
```

**Next request — pass the cursor back**

When `has_next` is `true`, take the three values from `next_cursor` and send them as query params:

```
?cursor_id=42&cursor_value=2025-01-01T00:00:00Z&limit=20
```

The response gives you the next batch, with a new `next_cursor` to continue paging.

**Last page — stop when `has_next` is false**

When `has_next` is `false`, `next_cursor` is `null`. You've received all the rows — stop sending requests.

::: info Unknown params are skipped
Any query param that doesn't match a declared field is silently ignored. You can safely include your own params on the same URL without conflicts — for example `?list_type=active&sort_by=name` works fine even if `list_type` isn't in the Schema.
:::

---

## All parameters

| Parameter | Example | Description |
|---|---|---|
| `sort_by` | `sort_by=name` | Column to sort by. Must be a field with `Sort: true`. |
| `sort_order` | `sort_order=asc` | `asc` or `desc`. Falls back to `DefaultSort` when omitted. |
| `limit` | `limit=20` | Rows per page. Clamped between `MinLimit` and `MaxLimit`. Default: 10. |
| `search` | `search=morgan` | Substring match across all `Search: true` fields. |
| `{column}_{op}` | `name_eq=morgan` | Filter — replace `{column}` with the field name and `{op}` with an allowed operator (`eq`, `neq`, `gt`, `gte`, `lt`, `lte`). |
| `cursor_id` | `cursor_id=42` | The `id` from `next_cursor` in the previous response. |
| `cursor_value` | `cursor_value=2025-01-01T...` | The `value` from `next_cursor` in the previous response. Use `null` for SQL NULL. |
