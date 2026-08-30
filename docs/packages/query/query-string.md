---
title: Query string — Query
description: URL parameters for sorting, filtering, searching, and cursor pagination.
---

# Query string

Once you've declared your [Schema](./schema), the client can control the list entirely through URL params. The package parses all of this from `r.URL.Query()` — you don't touch it in the handler.

---

## Sorting

Pick a column and a direction. Falls back to `DefaultSort` when omitted.

```
?sort_by=name&sort_order=asc
```

The value of `sort_by` must be a field with `Sort: true` in your `Schema.Fields`. Anything else is rejected with a 400.

---

## Filtering

The pattern is `{field}_{operator}=value`. The field must be declared in `Schema.Fields` and the operator must be in that field's `Filter` slice — anything outside that is rejected with a 400.

```
?status_eq=active
?name_eq=alice&created_at_gte=2025-01-01T00:00:00Z
```

Multiple filters are ANDed together. To filter for SQL NULL, use the string `null`:

```
?banned_at_eq=null
?banned_at_neq=null
```

---

## Search

Case-insensitive substring match across all fields marked `Search: true`. Results must contain the term in at least one of those columns.

```
?search=ali
```

---

## Pagination

The first request needs no cursor params — just an optional `limit`. Each response includes a `next_cursor` object when there are more rows:

```json
"next_cursor": { "id": 42, "value": "2025-01-01T00:00:00Z", "limit": 20 }
```

Send those three values back as query params to fetch the next page:

```
?cursor_id=42&cursor_value=2025-01-01T00:00:00Z&limit=20
```

When `has_next` is `false`, `next_cursor` is `null` — you've reached the end.

::: info Unknown params are skipped
Any query param that doesn't match a declared field is silently ignored. You can safely mix your own custom params on the same URL without conflicts.
:::

---

## All parameters

| Parameter | Example | Description |
|---|---|---|
| `sort_by` | `sort_by=name` | Field `Name` with `Sort: true`. |
| `sort_order` | `sort_order=asc` | `asc` or `desc`. |
| `limit` | `limit=20` | Rows per page. Clamped to `[MinLimit, MaxLimit]`. Default 10. |
| `search` | `search=alice` | Matches across `Search: true` fields. |
| `{field}_{op}` | `name_eq=alice` | Filter on a declared field with an allowed operator. |
| `cursor_id` | `cursor_id=42` | ID of the last row from the previous page. |
| `cursor_value` | `cursor_value=2025-01-01T...` | Sort-field value of the last row. Use `null` for SQL NULL. |
