---
title: Advanced — Query
description: Joins, DTOs, custom params, Fetch/FetchScan, cross-folder types, and error handling.
---

# Advanced

The [Getting started](/packages/query/) page covers the common case — a single table, standard columns, one handler. This page goes further. You'll find everything you need when a list spans multiple tables, requires logic before the query runs, works with types from another package, or needs precise control over error handling.

---

## Joins

When your list needs data from a joined table, use `query.ListScan` instead of `query.List`.

The reason: `List` uses GORM's `Find`, which auto-qualifies every column against the primary table. A `users.name AS user_name` alias becomes `orders.user_name` in the generated SELECT — a column that doesn't exist. `ListScan` uses `Scan` instead, which maps columns by name exactly as they come back from the query.

Declare joined columns in `Schema.Fields` with `Table` set to their actual SQL table, and `Source` set to the Go field name if it differs from `Name`:

```go
func (Order) Schema() query.Schema {
    return query.Schema{
        Table:       "orders",
        IDKind:      query.IDInt64,
        DefaultSort: query.Sort{By: "created_at", Order: "desc"},
        Fields: []query.Field{
            {Name: "created_at", Kind: query.KindTime,   Sort: true, Filter: []string{query.OpGte, query.OpLte}},
            // This column lives on the "users" table; the Go field is "UserName"
            {Name: "name",       Kind: query.KindString, Search: true, Table: "users", Source: "UserName"},
        },
    }
}
```

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

::: warning Scan does not Preload
`Scan` bypasses GORM's Preload lifecycle. If your model has associations declared with `Preload`, they will be `nil` after `ListScan` — with no error. Load associations manually after the page call, using the IDs from `page.Items`.
:::

---

## DTOs

When a join returns extra columns that don't belong on the base model, create a DTO struct. Embed the base model so it inherits its fields, and delegate `Schema()` back to it:

```go
type AdminTicketListItem struct {
    Ticket                                                  // inherits all Ticket fields
    UserName  string `gorm:"column:user_name"  json:"user_name"`
    UserEmail string `gorm:"column:user_email" json:"user_email"`
}

// Delegate — the list is still paged by the Ticket schema
func (AdminTicketListItem) Schema() query.Schema { return Ticket{}.Schema() }
```

---

## Custom filter params

Need a filter that isn't a plain column — like checking existence in a related table? Apply it to `db` before calling `List`. Params not declared in `Schema.Fields` are skipped, so there's no conflict:

```go
func GetAdminOrders(w http.ResponseWriter, r *http.Request, db *gorm.DB) {
    q := db.Model(&Order{})

    // "refunded_eq" is not in Schema — apply it manually
    if r.URL.Query().Get("refunded_eq") == "true" {
        q = q.Where("EXISTS (SELECT 1 FROM payment_refunds WHERE order_id = orders.id)")
    }

    page, err := query.ListScan[Order](q, r.URL.Query())
    // ...
}
```

---

## Inspecting filters before querying

`query.List` is `Parse` + `Fetch` combined. If you need to look at what the client sent before deciding what SQL to run, split them apart:

```go
func GetAdminUsers(w http.ResponseWriter, r *http.Request, db *gorm.DB) {
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

    // Only scope to active users when the client is searching
    if req.Search != nil {
        q = q.Where("active = true")
    }

    page, err := query.Fetch[User](q, *req)
    // ...
}
```

Use `query.FetchScan` instead of `query.Fetch` when you have joins.

---

## Listing types from another package

`query.List[T]` requires `T` to have a `Schema()` method. But Go doesn't let you add methods to a type defined in another package. The solution is a thin wrapper you own.

### Step 1 — The type you want to list

Say you have an `Invoice` type in a `billing/` folder that you didn't write and can't modify:

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

Create a new file in your own `models/` folder. Embed `billing.Invoice` so your wrapper inherits all of its fields:

```go
// models/invoice_list.go

type InvoiceListItem struct {
    billing.Invoice
}
```

Because of the embedding, GORM will scan database rows into `billing.Invoice`'s fields exactly as if you were querying `billing.Invoice` directly — no extra mapping needed.

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

Pass the wrapper as the type parameter (`InvoiceListItem`), and the original type as the GORM model (`billing.Invoice`):

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
If the external package already exports a schema function (e.g. `billing.InvoiceSchema()`), delegate to it instead of duplicating the declaration:

```go
func (InvoiceListItem) Schema() query.Schema { return billing.InvoiceSchema() }
```
:::

---

## Error handling

`query.IsRequestError(err)` returns `true` for errors caused by bad client input — invalid filter, unknown sort field, malformed cursor, or out-of-range limit. Map those to 400. Everything else is a server error.

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

### Sentinel errors

| Sentinel | HTTP | Cause |
|---|---|---|
| `ErrInvalidFilter` | 400 | Unknown operator or field not declared as filterable |
| `ErrInvalidSort` | 400 | `sort_by` value is not a declared sortable field |
| `ErrInvalidCursor` | 400 | Malformed `cursor_id` or `cursor_value` |
| `ErrInvalidLimit` | 400 | `limit` is outside `[MinLimit, MaxLimit]` |
| `ErrInvalidSchema` | 500 | Your `Schema()` is misconfigured — fix it, don't catch it |
| `ErrNilDB` | 500 | `db` passed to `List` is `nil` |
| `ErrCursorValue` | 500 | Struct field doesn't match the sort column — tags mismatch |
