---
title: Query
description: Cursor-paginated admin lists with filtering, search, and sort.
---

# Query

<Badge type="info" text="No migrations required" />

Every admin list needs the same things: sort by a column, filter by a value, search by a keyword, page through results, and return a consistent JSON shape. The `query/` package handles all of that. You declare which columns are queryable — the package reads the URL, validates the params, builds the SQL, and formats the response.

---

## Quick start

Getting a paginated admin list working takes two steps.

### Step 1 — Add `Schema()` to your model

`Schema()` is a method you add to your model struct. It tells the package which columns exist, what filters are allowed on each, and what the default sort should be when the client doesn't specify one.

Place it immediately after the struct definition, before any other method:

```go
// models/user.go

type User struct {
    ID        int64      `gorm:"primaryKey" json:"id"`
    Name      string     `json:"name"`
    Email     string     `json:"email"`
    BannedAt  *time.Time `json:"banned_at"` // pointer means the column can be NULL
    CreatedAt time.Time  `json:"created_at"`
}

func (User) Schema() query.Schema {
    return query.Schema{
        Table:       "users",       // your database table name
        IDKind:      query.IDInt64, // primary key type — IDInt64 for bigint, IDUUID for uuid
        DefaultSort: query.Sort{By: "created_at", Order: "desc"}, // sort when client doesn't specify

        Fields: []query.Field{
            // created_at: client can sort and filter by date range (gte = "on or after", lte = "on or before")
            {Name: "created_at", Kind: query.KindTime,   Sort: true, Filter: []string{query.OpGte, query.OpLte}},
            // name: client can sort, filter exact or exclude, and use in ?search=
            {Name: "name",       Kind: query.KindString, Sort: true, Filter: []string{query.OpEq, query.OpNeq}, Search: true},
            // email: client can filter exact and use in ?search=
            {Name: "email",      Kind: query.KindString,             Filter: []string{query.OpEq},              Search: true},
            // banned_at: nullable=true enables ?banned_at_eq=null → IS NULL
            {Name: "banned_at",  Kind: query.KindTime,               Filter: []string{query.OpEq, query.OpNeq}, Nullable: true},
        },
    }
}
```

Any column **not listed here** simply doesn't exist to the client — they can't sort or filter by it, even if it's in the database.

### Step 2 — Call `query.List` in your handler

Pass the database connection (scoped to your model) and the URL query params. The package does the rest.

```go
// handlers/admin_user_handler.go

func GetAdminUsers(w http.ResponseWriter, r *http.Request, db *gorm.DB) {
    // query.List validates the URL params against User's Schema, runs the
    // count query and the page query, and returns the results as a Page.
    page, err := query.List[User](db.Model(&User{}), r.URL.Query())
    if err != nil {
        // IsRequestError is true when the client sent a bad param —
        // an invalid filter, unknown sort field, or out-of-range limit.
        // Return 400 so the client knows to fix their request.
        if query.IsRequestError(err) {
            utils.JSONError(w, err, http.StatusBadRequest)
            return
        }
        // Anything else is a server-side problem.
        utils.JSONError(w, err, http.StatusInternalServerError)
        return
    }
    // page.Response wraps the results in the standard JSON envelope.
    utils.JSONResponse(w, http.StatusOK, page.Response(page.Items, nil))
}
```

That's all the code you need to write. This one handler now supports all of these out of the box, with no additional code:

```
GET /admin/users                                              → all users, default sort
GET /admin/users?sort_by=name&sort_order=asc                 → sorted alphabetically
GET /admin/users?search=morgan                               → search across name and email
GET /admin/users?name_eq=morgan                              → only users named "morgan"
GET /admin/users?created_at_gte=2025-01-01T00:00:00Z        → users created after Jan 1 2025
GET /admin/users?banned_at_eq=null                           → only users who are not banned
GET /admin/users?cursor_id=42&cursor_value=...&limit=20      → next page of results
```

::: tip One line. That's it.
Normally, adding a new filterable column means updating the SQL query, the validator, the handler, and probably a test or two. With `Schema()`, you add one `Field` and stop. The handler doesn't change. The route doesn't change. The client gets filtering, sorting, and search on that column immediately — fully validated, SQL-safe, and cursor-aware.
:::

---

## Choosing a function

`query.List` is the right choice for most cases. Use an alternative when your situation matches:

| Situation | Function |
|---|---|
| Plain table, no joins | `query.List` |
| You JOIN another table and select columns with `AS` aliases | `query.ListScan` |
| You need to look at the parsed filters before deciding what SQL to run | `query.Parse` → `query.Fetch` |
| Inspect filters first **and** you have a JOIN | `query.Parse` → `query.FetchScan` |

::: info List vs ListScan — what's the difference?
`query.List` uses GORM's `Find` internally. GORM `Find` is model-aware: it knows your struct and can automatically load associated rows (if you've set up GORM associations with `Preload`).

`query.ListScan` uses GORM's `Scan` instead. `Scan` just maps whatever columns come back from the query onto your struct by column name — it doesn't know anything about associations. **If you use `Preload` on your model, associations will be `nil` after `ListScan` with no error.** Only use `ListScan` when you have a JOIN with `AS` aliases. Details and examples are in [Joins](/packages/query/advanced#joins).
:::

---

## The response

`page.Response(data, extras)` builds the JSON envelope your frontend receives.

- **`data`** — what goes inside the `"data"` key. Pass `page.Items` to send the raw rows, or pass a transformed slice if you need to strip sensitive fields (like password hashes) before sending.
- **`extras`** — any additional metadata to include alongside the list. Pass `nil` if you don't need it.

```go
// Send rows as-is
utils.JSONResponse(w, http.StatusOK, page.Response(page.Items, nil))

// Strip sensitive fields before sending
utils.JSONResponse(w, http.StatusOK, page.Response(toSafeUsers(page.Items), nil))

// Include extra stats next to the list
utils.JSONResponse(w, http.StatusOK, page.Response(page.Items, map[string]any{
    "total_banned": 3,
}))
```

Every list returns the same JSON shape, so your frontend can handle pagination the same way across every admin table:

```json
{
  "data": [
    { "id": 9, "name": "morgan", "email": "morgan@example.com" }
  ],
  "pagination": {
    "limit": 20,
    "total": 142,      // total number of matching rows across all pages
    "has_next": true,  // when false, you've reached the last page
    "next_cursor": { "id": 9, "value": "morgan", "limit": 20 }
  },
  "sort":        { "sort_by": "name", "sort_order": "asc" },
  "filters":     [{ "key": "name", "value": "morgan", "operator": "eq" }],
  "search_term": "morg",
  "extras":      null
}
```

When `has_next` is `true`, pass the three values from `next_cursor` back as `cursor_id`, `cursor_value`, and `limit` to get the next page. When `has_next` is `false`, `next_cursor` is `null` — there are no more rows.
