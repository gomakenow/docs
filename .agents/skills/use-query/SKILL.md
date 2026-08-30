---
name: use-query
description: >
  Implement, modify, or debug admin list endpoints that use the query/ package.
  Use when adding or changing a paginated list handler, declaring Schema() on a
  model, working with joins or DTOs, writing custom filter params, splitting
  Parse+Fetch, or handling query sentinel errors. Also read when the task
  crosses into the URL parameters a client sends to drive sort, filter, search,
  or pagination.
---

# Use the Query package

Full docs: [Getting started](/packages/query/) · [Schema reference](/packages/query/schema) · [URL parameters](/packages/query/query-string) · [Advanced](/packages/query/advanced)

The `query/` package is an admin-list engine. It owns cursor pagination, filter/search/sort SQL, and the JSON envelope. It does **not** own routes, authentication, GORM models, or response transformers — those stay in the host.

```
Host (route, auth, db scope, transformer)
        │
        ▼
  query.List[T]   →  parse → filter → search → keyset page → next cursor
        │
        ▼
  host *gorm.DB (already scoped)
```

There are **no package tables**. Nothing to migrate.

---

## Before you start

1. Read the `query/` package source: `query/types.go`, `query/schema.go`, `query/list.go`.
2. Find one or two sibling list handlers in the codebase to understand local conventions for scoping `db`, error mapping, and response shape.
3. If the list involves a join or a DTO, read [Advanced — Joins](/packages/query/advanced#joins) before writing any code.

---

## Implement a list handler

### 1. Declare Schema() on the model

Place `Schema()` immediately after the struct — before `TableName`, `BeforeCreate`, or any other method. This is the contract visibility rule: struct → `Schema()` → everything else.

```go
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

### 2. Choose the right function

| Situation | Use |
|---|---|
| Plain table, no JOIN aliases | `query.List` |
| JOIN with `AS` aliases, or scanning into a DTO | `query.ListScan` |
| Already called `Parse` to inspect filters first, no aliases | `query.Fetch` |
| Already called `Parse`, JOIN aliases / DTO | `query.FetchScan` |

`List` / `Fetch` use GORM `Find` — model-aware, `Preload` still runs.
`ListScan` / `FetchScan` use GORM `Scan` — **Preload does NOT run silently**. Associations come back nil. Load them manually after the page call.

### 3. Write the handler

**Plain table:**

```go
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

Transform `page.Items` before passing to `Response` if the raw model is not public-safe (e.g. strip password hashes).

**With a JOIN:**

```go
func GetAdminOrders(w http.ResponseWriter, r *http.Request, db *gorm.DB) {
    q := db.Model(&Order{}).
        Joins("JOIN users ON users.id = orders.user_id").
        Select("orders.*, users.name AS user_name, users.email AS user_email")

    page, err := query.ListScan[Order](q, r.URL.Query())
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

Declare joined columns in `Schema.Fields` with `Table` (SQL table) and `Source` (Go field when it differs from `Name`):

```go
{Name: "name", Kind: query.KindString, Search: true, Table: "users", Source: "UserName"},
```

---

## Common patterns

### Host-owned filter params

Unknown URL params are silently skipped by the package. Read them yourself and apply `Where` before calling `List`:

```go
if r.URL.Query().Get("refunded_eq") == "true" {
    q = q.Where("EXISTS (SELECT 1 FROM refunds WHERE order_id = orders.id)")
}
page, err := query.ListScan[Order](q, r.URL.Query())
```

### Inspecting filters before querying (Parse + Fetch)

`List` is `Parse` + `Fetch` combined. Split them when you need to look at what the client sent before deciding what SQL to run:

```go
req, err := query.Parse(User{}.Schema(), r.URL.Query())
if err != nil { /* map error */ }

q := db.Model(&User{})
if req.Search != nil {
    q = q.Where("active = true")
}

page, err := query.Fetch[User](q, *req)
```

Use `query.FetchScan` for joins.

### DTOs (join with extra columns)

Embed the base model, delegate `Schema()` back to it:

```go
type AdminOrderListItem struct {
    Order
    UserName  string `gorm:"column:user_name"  json:"user_name"`
    UserEmail string `gorm:"column:user_email" json:"user_email"`
}

func (AdminOrderListItem) Schema() query.Schema { return Order{}.Schema() }
```

### Listing types from another package

Go doesn't allow adding methods to types from another package. Wrap the external type:

```go
// models/invoice_list.go

type InvoiceListItem struct{ billing.Invoice }

func (InvoiceListItem) Schema() query.Schema {
    return query.Schema{ /* ... */ }
    // or delegate: return billing.InvoiceSchema()
}
```

```go
page, err := query.List[InvoiceListItem](db.Model(&billing.Invoice{}), r.URL.Query())
```

---

## Error handling

```go
if err != nil {
    if query.IsRequestError(err) {
        utils.JSONError(w, err, http.StatusBadRequest)
        return
    }
    utils.JSONError(w, err, http.StatusInternalServerError)
    return
}
```

| Sentinel | HTTP | Cause |
|---|---|---|
| `ErrInvalidFilter` | 400 | Unknown operator or undeclared field |
| `ErrInvalidSort` | 400 | `sort_by` not a declared sortable field |
| `ErrInvalidCursor` | 400 | Malformed `cursor_id` or `cursor_value` |
| `ErrInvalidLimit` | 400 | `limit` outside `[MinLimit, MaxLimit]` |
| `ErrInvalidSchema` | 500 | Misconfigured `Schema()` — fix the bug, don't catch it |
| `ErrNilDB` | 500 | `nil` db passed to `List` |
| `ErrCursorValue` | 500 | Struct field/tag mismatch on the sort column |

---

## Schema field reference

| Option | Description |
|---|---|
| `Name` | **Required.** URL param prefix and SQL column — must match the DB column name. |
| `Kind` | Required when `Sort` or `Filter` is set. `KindString`, `KindTime`, `KindInt`, `KindFloat`, `KindBool`. |
| `Sort` | Allow `sort_by=this_field`. |
| `Filter` | Allowed operators. Empty = not filterable. |
| `Search` | Include in `?search=` (`ILIKE` on Postgres). |
| `Nullable` | Column can be SQL NULL — enables `field_eq=null` → `IS NULL` and correct cursor sort. |
| `Table` | Override SQL table for this column (joined columns). |
| `Source` | Go struct field when it doesn't match `Name` (join aliases). |
| `JSON` | `Name` is a dotted jsonb path (`"meta.key"` → `meta->>'key'`). |

`IDKind`: `IDInt64` (bigint PK) or `IDUUID` (uuid PK). Controls cursor tie-breaker encoding only — unrelated to foreign keys.

---

## What NOT to do

- Do not write `GetXWithPagination`, `GetXCount`, `CalculateNextCursor`, `GetValidFilters` on the model — the package handles all of it.
- Do not put host-only params (custom exists-checks, business flags) in `Schema.Fields` — apply them as `Where` before `List`.
- Do not expect `Preload` to run after `ListScan` — load associations manually.
- Do not invent a second JSON envelope — always use `page.Response(...)`.
