---
title: Query
description: Cursor-paginated admin lists with filtering, search, and sort.
---

# Query

<Badge type="info" text="No migrations required" />

Every admin list in your app needs the same things: sort, filter, search, cursor pagination, a consistent JSON response. The `query/` folder handles all of that. You declare what columns exist on your model — the package takes care of parsing the URL, building SQL, counting rows, and formatting the response.

---

## Quick start

Getting a paginated admin list working takes two steps.

### Step 1 — Add `Schema()` to your model

`Schema()` is a value-receiver method that tells `query/` what columns exist, which operators they accept, and what the default sort is. Place it immediately after the struct, before any other method.

```go
// models/user.go

type User struct {
    ID        int64      `gorm:"primaryKey" json:"id"`
    Name      string     `json:"name"`
    Email     string     `json:"email"`
    BannedAt  *time.Time `json:"banned_at"`
    CreatedAt time.Time  `json:"created_at"`
}

func (User) Schema() query.Schema {
    return query.Schema{
        Table:       "users",
        IDKind:      query.IDInt64,
        DefaultSort: query.Sort{By: "created_at", Order: "desc"},
        Fields: []query.Field{
            {Name: "created_at", Kind: query.KindTime,   Sort: true, Filter: []string{query.OpGte, query.OpLte}},
            {Name: "name",       Kind: query.KindString, Sort: true, Filter: []string{query.OpEq, query.OpNeq}, Search: true},
            {Name: "email",      Kind: query.KindString, Sort: true, Filter: []string{query.OpEq},              Search: true},
            {Name: "banned_at",  Kind: query.KindTime,   Sort: true, Filter: []string{query.OpEq, query.OpNeq}, Nullable: true},
        },
    }
}
```

### Step 2 — Call `query.List` in your handler

Pass the scoped `db` and the URL query params. The package does the rest.

```go
// handlers/admin_user_handler.go

func GetAdminUsers(w http.ResponseWriter, r *http.Request, db *gorm.DB) {
    page, err := query.List[User](db.Model(&User{}), r.URL.Query())
    if err != nil {
        if query.IsRequestError(err) {
            utils.JSONError(w, err, http.StatusBadRequest)
            return
        }
        utils.JSONError(w, err, http.StatusInternalServerError)
        return
    }
    utils.JSONResponse(w, http.StatusOK, page.Response(page.Items, nil))
}
```

That's it. This handler now supports all of these out of the box, with no additional code:

```
GET /admin/users
GET /admin/users?sort_by=name&sort_order=asc
GET /admin/users?search=alice
GET /admin/users?name_eq=alice&created_at_gte=2025-01-01T00:00:00Z
GET /admin/users?banned_at_eq=null
GET /admin/users?cursor_id=42&cursor_value=2025-01-01T00:00:00Z&limit=20
```

::: tip Adding a new column
To make a new column sortable or filterable, add one `Field` to `Schema()`. The handler doesn't change at all.
:::

---

## The response

`page.Response(data, extras)` builds the JSON envelope. The first argument is what appears under `"data"` — pass `page.Items` to send the raw rows, or a transformed slice if you need to strip sensitive fields. The second argument is for any extra metadata (counts, stats, etc.); pass `nil` if you don't need it.

```go
// Send rows as-is
page.Response(page.Items, nil)

// Strip sensitive fields before sending
page.Response(toPublicUsers(page.Items), nil)

// Include extra metadata alongside the list
page.Response(toPublicUsers(page.Items), map[string]any{"total_banned": 3})
```

Every list in your app returns the same shape, so your frontend can handle pagination identically across all admin tables:

```json
{
  "data": [
    { "id": 9, "name": "alice", "email": "alice@example.com" }
  ],
  "pagination": {
    "limit": 20,
    "total": 142,
    "has_next": true,
    "next_cursor": { "id": 9, "value": "alice", "limit": 20 }
  },
  "sort":        { "sort_by": "name", "sort_order": "asc" },
  "filters":     [{ "key": "name", "value": "alice", "operator": "eq" }],
  "search_term": "ali",
  "extras":      null
}
```

When `has_next` is `true`, there are more rows. Grab `cursor_id`, `cursor_value`, and `limit` from `next_cursor` and send them as query params to get the next page. When `has_next` is `false`, `next_cursor` is `null` — you've reached the end.
