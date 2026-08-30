# New admin table

Add a cursor-paginated admin list with [`query/`](/packages/query/). Put `Schema()` on your model. The handler calls `query.List`. You still register the route and auth.

## 1. Declare the table on the model

Struct first, `Schema()` immediately after. `T` in `query.List[T]` must implement `query.Schemer`.

```go
type Article struct {
    ID        int64     `json:"id"`
    Title     string    `json:"title"`
    Status    string    `json:"status"`
    CreatedAt time.Time `json:"created_at"`
}

func (Article) Schema() query.Schema {
    return query.Schema{
        Table:       "articles",
        DefaultSort: query.Sort{By: "created_at", Order: "desc"},
        IDKind:      query.IDInt64,
        Fields: []query.Field{
            {Name: "created_at", Kind: query.KindTime, Sort: true, Filter: []string{query.OpGte, query.OpLte}},
            {Name: "title", Kind: query.KindString, Sort: true, Filter: []string{query.OpEq}, Search: true},
            {Name: "status", Kind: query.KindString, Sort: true, Filter: []string{query.OpEq, query.OpNeq}},
        },
    }
}
```

Do not add `GetValidFilters`, `GetXWithPagination`, `GetXCount`, or `CalculateNextCursor`.

## 2. List in the handler

```go
func GetAdminArticles(w http.ResponseWriter, r *http.Request, db *gorm.DB) {
    page, err := query.List[Article](db.Model(&Article{}), r.URL.Query())
    if err != nil {
        status := http.StatusInternalServerError
        if query.IsRequestError(err) {
            status = http.StatusBadRequest
        }
        writeError(w, err, status)
        return
    }
    writeJSON(w, http.StatusOK, page.Response(toPublicArticles(page.Items), nil))
}
```

That is the whole list: filters, search, sort, cursor, count, envelope.

## 3. Route and auth

- Register `GET` behind admin auth.
- Extra visibility: `Where` on `db` **before** `List` (`query/` does not authorize).
- Transform `page.Items` if the raw model is not public-safe.

Joins / `AS` aliases / `Preload`: use `ListScan` and read the [Joins section](/packages/query/advanced#joins) in the Advanced page.

## 4. Frontend URL

```
GET /admin/articles?sort_by=created_at&sort_order=desc&limit=20
    &status_eq=published&search=draft
```

`page.Response` already speaks `data` + `pagination.next_cursor`. Send `cursor_id` and `cursor_value` from `next_cursor` for the next page.
