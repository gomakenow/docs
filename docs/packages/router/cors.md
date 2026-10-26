---
title: CORS and roots
description: How the root router applies the CORS policy, what each CORS field does, and how not-found and method-not-allowed are handled.
---

# CORS and roots

This page covers the settings that belong to the **root router**: the one you get from `router.New()`, as opposed to a group.

There are three of them:

- the CORS policy, set with `SetCORS`
- the not-found handler, set with `NotFound`
- the method-not-allowed handler, set with `MethodNotAllowed`

---

## What CORS is

A browser blocks a web page from calling an API on a different origin, unless the API says it is allowed. "Origin" means scheme, host, and port together, so `https://example.com` and `https://api.example.com` are two different origins.

The API says "allowed" with response headers such as `Access-Control-Allow-Origin`. For some requests, the browser first sends a small question called a **preflight**: an `OPTIONS` request that asks "may I send a `DELETE` with an `Authorization` header?". The browser only sends the real request if the answer is yes.

`SetCORS` makes the router answer those questions and add those headers for you.

---

## Setting the policy

```go
r := router.New()

r.SetCORS(router.CORS{
    AllowedHeaders: []string{"Content-Type", "Authorization"},
    AllowedMethods: []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
    AllowedOrigins: []string{"https://example.com"},
})

http.ListenAndServe(":8080", r)
```

`SetCORS` returns the router, so you can chain it. Calling it again replaces the policy.

---

## How it is applied

The policy is applied in the root router's `ServeHTTP`, before the request reaches the routes. The request flows like this:

```
request → CORS → route matching → group middleware → route middleware → handler
```

This has some results worth knowing:

- **A preflight request is answered by the CORS layer.** It never reaches a route, a group, or any of your middleware. A route does not need to allow `OPTIONS` for a preflight to work.
- **A request from an origin that is not allowed still reaches your handler.** The router does not block it. It just leaves out the `Access-Control-Allow-Origin` header, and the browser then refuses to give the response to the page. A non-browser client, like `curl`, is not affected by CORS at all.
- **A preflight that asks for something not allowed gets `403`.** For example, a header that is not in `AllowedHeaders`.
- **A successful preflight gets `200`** unless you change it with `OptionStatusCode`.

If `SetCORS` was never called, the router has no CORS layer and requests go straight to route matching.

### Serving the root

CORS lives in the `ServeHTTP` of the root router. So the thing you pass to `http.ListenAndServe` decides whether CORS is on:

| You serve | CORS applied |
|---|---|
| The router from `router.New()` | Yes |
| A group, or a `Subrouter()` | No. It has no policy of its own |
| The underlying `*mux.Router` (`r.Router`) | No. It skips the router's `ServeHTTP` |

A group returned by `Group` has no CORS of its own, but it does not need one when the requests arrive through the root.

### Wrapping an existing mux

`router.Wrap(parent)` builds a router on a mux you already have:

```go
parent := mux.NewRouter()
r := router.Wrap(parent)
```

Routes you add through `r` are registered on `parent`. CORS is set on `r`, so only requests served through `r` get it. Serving `parent` directly skips it.

---

## The CORS fields

| Field | What it does | If you leave it empty |
|---|---|---|
| `AllowedHeaders` | Request headers the browser may send | Gorilla's default |
| `AllowedMethods` | Methods the browser may use | Gorilla's default |
| `AllowedOrigins` | Origins allowed to call the API | All origins are allowed |
| `ExposedHeaders` | Response headers that page JavaScript may read | None are exposed |
| `AllowCredentials` | Lets the browser send cookies and the `Authorization` header across origins | `false` |
| `MaxAge` | Seconds the browser may remember a preflight answer | Not set |
| `OptionStatusCode` | Status code of a successful preflight response | Gorilla's default (`200`) |
| `IgnoreOptions` | Passes `OPTIONS` requests to your routes instead of answering them | `false` |
| `OriginValidator` | A function that decides if an origin is allowed | Not set |

"Gorilla's default" means the router adds no option for that field, and the underlying `gorilla/handlers` CORS handler uses its own default. A field left at its zero value never overrides it.

### AllowedOrigins and OriginValidator

`AllowedOrigins` is a fixed list. The origin must match an entry exactly, scheme and port included:

```go
AllowedOrigins: []string{"https://example.com", "http://example.com"}
```

`OriginValidator` is a function for when a list is not enough:

```go
r := router.New()

r.SetCORS(router.CORS{
    AllowedMethods: []string{"GET", "OPTIONS"},
    OriginValidator: func(origin string) bool {
        return strings.HasSuffix(origin, ".example.com")
    },
})
```

It gets the origin from the request and returns `true` to allow it.

### Credentials

With `AllowCredentials: true`, the router adds `Access-Control-Allow-Credentials: true`. Browsers do not accept a wildcard origin together with credentials, so the response has to name the origin. Using a list or an `OriginValidator` does that: the router answers with the caller's own origin when it is allowed.

### Exposed headers

By default JavaScript on the page can only read a small set of response headers. `ExposedHeaders` adds more to that list:

```go
ExposedHeaders: []string{"X-Request-ID"}
```

Header names are written in their canonical form in the response, so `X-Request-ID` is sent as `X-Request-Id`.

---

## Not found and method not allowed

```go
r := router.New()

r.NotFound(http.HandlerFunc(notFound))
r.MethodNotAllowed(http.HandlerFunc(methodNotAllowed))
```

| Method | Handles |
|---|---|
| `NotFound` | A request whose path matches no route |
| `MethodNotAllowed` | A request whose path matches a route, but with a method that route does not allow |

For example, with a route registered as `GET /tickets`:

| Request | Handler |
|---|---|
| `GET /missing` | `NotFound` |
| `POST /tickets` | `MethodNotAllowed` |

Both take any `http.Handler`, so you choose the status code and the body. Both return the router, so they chain.

Without them, the router uses gorilla/mux's plain defaults: a `404` for no match and a `405` for a wrong method.

These handlers are set on the root. They run after the CORS layer, so their responses carry CORS headers like any other response.

Middleware passed to `Use` or `Group` does not run for these two handlers, because no route matched.
