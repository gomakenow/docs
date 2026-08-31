---
title: Advanced — Query
description: Joins, DTOs, custom params, Fetch/FetchScan, cross-folder types, and error handling.
---

# Advanced

The [Getting started](/packages/query/) page covers the common case — a single table, standard columns, one handler. This page goes further. You'll find everything you need when a list spans multiple tables, requires logic before the query runs, works with types from another package, or needs precise control over error handling.

---

## Joins

When your list needs columns from a joined table, you must use `query.ListScan` instead of `query.List`.

**Why `query.List` breaks with joins**

`query.List` uses GORM's `Find` internally. GORM `Find` is "model-aware" — it reads your Go struct and automatically prepends the table name to every column in the `SELECT`. This is normally helpful, but it breaks with join aliases.

Say you write:

```go
db.Model(&Order{}).
    Joins("JOIN users ON users.id = orders.user_id").
    Select("orders.*, users.name AS user_name")
```

GORM's `Find` turns `AS user_name` into `orders.user_name` in the final SQL — a column that doesn't exist on the `orders` table. The query fails.

`query.ListScan` uses GORM's `Scan` instead. `Scan` maps columns by the exact name they come back with from the query — no auto-prefixing. So `AS user_name` maps cleanly to a `UserName` field in your struct.

**Declaring joined columns in Schema**

Tell the package where each column lives by setting `Table` (the SQL table it comes from) and `Source` (the Go struct field name if it differs from `Name`):

```go
func (Order) Schema() query.Schema {
    return query.Schema{
        Table:       "orders",
        IDKind:      query.IDInt64,
        DefaultSort: query.Sort{By: "created_at", Order: "desc"},
        Fields: []query.Field{
            // "created_at" lives on the orders table — no Table override needed
            {Name: "created_at", Kind: query.KindTime, Sort: true, Filter: []string{query.OpGte, query.OpLte}},
            // "name" lives on the users table; the Go field is "UserName" (from AS user_name)
            {Name: "name", Kind: query.KindString, Search: true, Table: "users", Source: "UserName"},
        },
    }
}
```

**The handler**

```go
func GetAdminOrders(w http.ResponseWriter, r *http.Request, db *gorm.DB) {
    q := db.Model(&Order{}).
        Joins("JOIN users ON users.id = orders.user_id").
        Select("orders.*, users.name AS user_name")

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

::: warning ListScan does not load associations
`Scan` bypasses GORM's association-loading lifecycle. If your model uses GORM `Preload` to automatically load related rows (e.g. a `Comments []Comment` field on a `Post`), those fields will be `nil` after `ListScan` — with no error, no warning, just empty fields.

If you need associations, load them manually after the page call using the IDs from `page.Items`.
:::

---

## DTOs

**What is a DTO?**

DTO stands for "Data Transfer Object" — a struct whose only purpose is to carry data from a query to the handler, without mixing extra columns into your main model.

**When do you need one?**

When a join returns extra columns that don't belong on the base model, you need a place to put them. Adding `UserName` and `UserEmail` directly to the `Order` struct would mix join-specific data into a model that's also used for creating and updating orders — that's messy.

A DTO solves this cleanly: it embeds the base model (inheriting all its fields) and adds only the extra join columns.

```go
type AdminOrderListItem struct {
    Order                                                   // inherits all Order fields
    UserName  string `gorm:"column:user_name"  json:"user_name"`
    UserEmail string `gorm:"column:user_email" json:"user_email"`
}

// Delegate Schema() back to the base model — the list is still paged by Order's schema
func (AdminOrderListItem) Schema() query.Schema { return Order{}.Schema() }
```

Use `AdminOrderListItem` as the type parameter in `ListScan`:

```go
page, err := query.ListScan[AdminOrderListItem](q, r.URL.Query())
```

GORM maps the `user_name` and `user_email` columns onto the DTO fields. The `Order` fields come along via embedding — no extra mapping needed.

---

## Custom filter params

Sometimes you need a filter that can't be expressed as a simple column check — for example, "show only orders that have at least one refund". This involves a subquery or a join condition, not a plain `WHERE orders.status = '...'`.

The package only processes URL params that are declared in `Schema.Fields` — anything else is silently skipped. This means you can safely read your own custom params from the URL and apply them to `db` before calling `List`, with no conflicts.

```go
func GetAdminOrders(w http.ResponseWriter, r *http.Request, db *gorm.DB) {
    q := db.Model(&Order{})

    // "refunded_eq" is not declared in Schema — read it manually and apply your own SQL
    if r.URL.Query().Get("refunded_eq") == "true" {
        q = q.Where("EXISTS (SELECT 1 FROM payment_refunds WHERE order_id = orders.id)")
    }

    page, err := query.List[Order](q, r.URL.Query())
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

The `?refunded_eq=true` param is invisible to the package — it applies your `WHERE EXISTS` condition and then passes the scoped `db` in. The package adds its own filters, search, sort, and cursor on top.

---

## Inspecting filters before querying

`query.List` is shorthand for two steps: parse the URL params, then run the query. Most of the time you don't need to split these apart.

But sometimes you need to look at what the client sent *before* deciding what SQL to run. For example: "if the client is searching, also scope the results to active users only". You can't do that after the fact — you need to know about the search term before building the `WHERE` clause.

For this, call `query.Parse` and `query.Fetch` separately:

```go
func GetAdminUsers(w http.ResponseWriter, r *http.Request, db *gorm.DB) {
    // Step 1: parse and validate the URL params — same validation as query.List,
    // but gives you a Request object you can inspect before querying.
    req, err := query.Parse(User{}.Schema(), r.URL.Query())
    if err != nil {
        if query.IsRequestError(err) {
            utils.JSONError(w, err, http.StatusBadRequest)
            return
        }
        utils.JSONError(w, err, http.StatusInternalServerError)
        return
    }

    q := db.Model(&User{})

    // Step 2: inspect the parsed request and conditionally modify the query
    if req.Search != nil {
        // client sent ?search= — only include active users in search results
        q = q.Where("active = true")
    }

    // Step 3: run the page query with the already-parsed request
    page, err := query.Fetch[User](q, *req)
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

Use `query.FetchScan` instead of `query.Fetch` when your query has a JOIN with `AS` aliases.

---

## Listing types from another package

`query.List[T]` requires `T` to have a `Schema()` method. But Go has a rule: you can only add methods to types defined in the **same package**. If a type comes from another package (a package you didn't write), you can't add `Schema()` to it directly.

The solution is a thin wrapper struct that you own.

### Step 1 — The type you want to list

Say you have an `Invoice` type in a `billing/` package that you can't modify:

```go
// billing/models/invoice.go  (not your code)

type Invoice struct {
    ID       int64     `json:"id"`
    Status   string    `json:"status"`
    Total    int64     `json:"total"`
    IssuedAt time.Time `json:"issued_at"`
}
```

You want an admin list endpoint for it, but you can't add `Schema()` to `billing.Invoice` from outside the package.

### Step 2 — Create a wrapper in your models folder

Create a new file in your own `models/` folder and embed `billing.Invoice`:

```go
// models/invoice_list.go

type InvoiceListItem struct {
    billing.Invoice // embed the external type — your struct inherits all its fields
}
```

By embedding, GORM will scan database rows into `billing.Invoice`'s fields exactly as if you were querying `billing.Invoice` directly. No extra mapping needed.

### Step 3 — Add Schema() to the wrapper

Now add `Schema()` to your wrapper. This is the only method you need:

```go
func (InvoiceListItem) Schema() query.Schema {
    return query.Schema{
        Table:       "invoices",
        IDKind:      query.IDInt64,
        DefaultSort: query.Sort{By: "issued_at", Order: "desc"},
        Fields: []query.Field{
            {Name: "issued_at", Kind: query.KindTime,   Sort: true, Filter: []string{query.OpGte, query.OpLte}},
            {Name: "status",    Kind: query.KindString, Sort: true, Filter: []string{query.OpEq, query.OpNeq}},
            {Name: "total",     Kind: query.KindInt,    Sort: true, Filter: []string{query.OpGte, query.OpLte}},
        },
    }
}
```

### Step 4 — Use it in the handler

Pass the wrapper as the type parameter, and the original type as the GORM model. The wrapper (`InvoiceListItem`) is what satisfies `Schema()`. The model (`billing.Invoice`) is what GORM uses to build the SQL.

```go
func GetAdminInvoices(w http.ResponseWriter, r *http.Request, db *gorm.DB) {
    page, err := query.List[InvoiceListItem](db.Model(&billing.Invoice{}), r.URL.Query())
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

### Full example

```go
// models/invoice_list.go

type InvoiceListItem struct {
    billing.Invoice
}

func (InvoiceListItem) Schema() query.Schema {
    return query.Schema{
        Table:       "invoices",
        IDKind:      query.IDInt64,
        DefaultSort: query.Sort{By: "issued_at", Order: "desc"},
        Fields: []query.Field{
            {Name: "issued_at", Kind: query.KindTime,   Sort: true, Filter: []string{query.OpGte, query.OpLte}},
            {Name: "status",    Kind: query.KindString, Sort: true, Filter: []string{query.OpEq, query.OpNeq}},
            {Name: "total",     Kind: query.KindInt,    Sort: true, Filter: []string{query.OpGte, query.OpLte}},
        },
    }
}
```

```go
// handlers/admin_invoice_handler.go

func GetAdminInvoices(w http.ResponseWriter, r *http.Request, db *gorm.DB) {
    page, err := query.List[InvoiceListItem](db.Model(&billing.Invoice{}), r.URL.Query())
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

::: tip Delegating an existing schema function
If the external package already exports a schema function (e.g. `billing.InvoiceSchema()`), delegate to it instead of duplicating the field list:

```go
func (InvoiceListItem) Schema() query.Schema { return billing.InvoiceSchema() }
```
:::

---

## Error handling

When `query.List` (or `ListScan`, `Fetch`, `FetchScan`) returns an error, it's one of two kinds:

- **Client error** — the client sent a bad URL param (unknown filter field, disallowed operator, malformed cursor, limit out of range). Return **400 Bad Request** so the client knows to fix their request.
- **Server error** — something went wrong on your side (misconfigured Schema, nil db, struct field mismatch). Return **500 Internal Server Error**.

`query.IsRequestError(err)` tells you which kind it is:

```go
if err != nil {
    if query.IsRequestError(err) {
        // bad client input → tell the client what was wrong
        utils.JSONError(w, err, http.StatusBadRequest)
        return
    }
    // server-side problem → log it and return 500
    utils.JSONError(w, err, http.StatusInternalServerError)
    return
}
```

### Error reference

These are the specific errors the package can return. Errors from the 400 group are safe to surface to the client — they contain a message describing what was wrong with the request. Errors from the 500 group indicate a bug in your code that needs to be fixed.

| Error | HTTP | What caused it |
|---|---|---|
| `ErrInvalidFilter` | 400 | Client used an operator that isn't in the field's `Filter` slice, or used a field that isn't declared in `Schema.Fields` |
| `ErrInvalidSort` | 400 | Client sent `sort_by=something` but `something` isn't a field with `Sort: true` |
| `ErrInvalidCursor` | 400 | `cursor_id` or `cursor_value` from the previous page is malformed or corrupted |
| `ErrInvalidLimit` | 400 | Client sent a `limit` below `MinLimit` or above `MaxLimit` |
| `ErrInvalidSchema` | 500 | Your `Schema()` has a configuration mistake — fix the bug, don't catch this error |
| `ErrNilDB` | 500 | You passed a `nil` db to `List` — check your dependency injection |
| `ErrCursorValue` | 500 | The struct field the package is trying to read for the cursor doesn't match the sort column — your GORM/JSON tags don't align |
