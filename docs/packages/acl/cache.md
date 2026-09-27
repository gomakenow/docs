---
title: Cache
description: In-memory permission caching. Disable it, replace it with custom implementations, or use the built-in.
---

# Cache

Permission checks are fast, but they still hit the database. The ACL engine includes an optional in-memory cache that stores a user's permission set after the first check. Subsequent checks for that user use the cached set and skip the database.

This page explains how the cache works, when it invalidates, how to turn it off, and how to replace it with your own implementation (for example, a Redis cache shared across multiple processes).

---

## How the cache works

When you call `engine.Can` for a user the first time, the engine:
1. Queries the database for all permissions the user has (from roles and direct grants)
2. Stores the result in memory as a set of permission name strings
3. Returns the answer

The next time you call `engine.Can` for the same user, the engine:
1. Finds the cached permission set
2. Returns the answer without hitting the database

The cache key is a composite: `subject_id:subject_type:tenant_id`. User `42` in tenant `"default"` is different from user `42` in tenant `"acme-corp"`. They each have their own cache entry.

### What gets cached

The cache stores the **resolved permission set**: every permission name the user has, from all sources combined (roles and direct grants), as a list of strings. For example: `["ticket.view", "ticket.reply", "invoice.refund"]`.

This is different from:
- **Role assignments** (which roles the user holds) — these are not cached; `engine.RolesFor` always hits the database
- **Individual permission checks** (yes or no for one permission) — these are not cached; instead, the full set is cached and checked in memory

::: info Cache is memory-efficient
One user's cache entry is at most as large as your permission catalog. Even if a user holds 1000 roles, the cache stores one entry: the flat list of all unique permission names. A typical app with 50 permissions caches maybe 100–200 bytes per user.
:::

### Cache invalidation

Nothing expires by time. The cache is only cleared when something changes. Here is what changes trigger invalidation:

| Operation | Cache entries invalidated |
|---|---|
| `engine.Grant(ctx, user, perm, tenant)` | User's entry in that tenant |
| `engine.Revoke(ctx, user, perm, tenant)` | User's entry in that tenant |
| `engine.AssignRole(ctx, user, role, tenant)` | User's entry in that tenant |
| `engine.RevokeRole(ctx, user, role, tenant)` | User's entry in that tenant |
| `engine.AddPermissionToRole(ctx, roleID, perm)` | Every user who holds that role in any tenant |
| `engine.RemovePermissionFromRole(ctx, roleID, perm)` | Every user who holds that role in any tenant |
| `engine.SetRolePermissions(ctx, roleID, perms)` | Every user who holds that role in any tenant |
| `engine.DeleteRole(ctx, roleID)` | Every user who held that role in any tenant |
| `acl.New(ctx, db, config)` at startup | Deletes permissions that left `permission.go` for all users who had them |

Operations that do **not** invalidate the cache:
- `engine.CreateRole` — new roles have no permissions yet, so no user's set changes
- Creating a new permission in `permission.go` — existing users do not have it yet

The superadmin flag has a separate cache entry (`superadmin:<subject_id>`). Email-based superadmin (checking `SuperadminEmailOrID` on every call) is never cached — it is always fresh.

---

## Built-in memory cache

By default, the cache is a simple in-memory map on the engine. It is fast, thread-safe, and requires no setup.

```go
engine, err := acl.New(ctx, db, &acl.Config{
    SubjectFunc: subjectFunc,
    // No Cache field, no DisableCache field
    // → Uses built-in memory cache
})
```

The map lives on the single engine instance, created at startup. One process has one engine and one map. HTTP handlers and background jobs in that process all share it. A second instance of the application (another process) has its own separate engine and its own separate cache.

This is perfect for single-process applications or when each process can have its own cache. For distributed systems where multiple processes need to see the same cache, you need a different approach.

---

## Disabling the cache

If you want every permission check to hit the database without caching, set `DisableCache: true` when you create the engine instance with `acl.New`.

```go
engine, err := acl.New(ctx, db, &acl.Config{
    SubjectFunc: subjectFunc,
    DisableCache: true,  // Disable caching at startup
    // No cache is built or used
})
```

Every call to `engine.Can`, `engine.CanAny`, `engine.CanAll`, `engine.CanGlobal`, `engine.PermissionsFor`, and `engine.IsSuperadmin` queries the database directly.

Use this when:
- You need permissions to update immediately across all processes (cache would be stale on other instances)
- Permissions change frequently and staleness is not acceptable
- Your database is fast enough that the overhead is acceptable

The downside is increased database load. In high-traffic applications, even caching within a single process can significantly reduce queries.

---

## Custom cache implementations

If you want a cache that is shared across multiple processes (or uses different logic), implement the `Cache` interface and pass it to the engine via the `Cache` config field.

```go
cache := &MyCustomCache{/* ... */}

engine, err := acl.New(ctx, db, &acl.Config{
    SubjectFunc: subjectFunc,
    Cache: cache,  // Use your custom cache instead of built-in
})
```

### The Cache interface

```go
type Cache interface {
    // Get retrieves the permission set for a key.
    // Returns the permissions and a boolean: true if found, false if miss.
    Get(key string) ([]string, bool)
    
    // Set stores the permission set for a key.
    Set(key string, perms []string)
    
    // Invalidate removes a key from the cache.
    Invalidate(key string)
}
```

### Cache keys

The engine generates cache keys in the format: `subject_id:subject_type:tenant_id`

For example:
- `42:user:default` — User `42` in the default tenant
- `cron-close-tickets:machine:default` — Machine `cron-close-tickets`
- `42:user:acme-corp` — User `42` in the `acme-corp` tenant

Your implementation receives these keys and stores whatever permission lists you want.

### Example: Redis cache

Here is a sketch of a Redis-backed cache that would work across multiple processes:

```go
type RedisCache struct {
    client *redis.Client
}

func (rc *RedisCache) Get(key string) ([]string, bool) {
    // Try to get from Redis
    val, err := rc.client.Get(context.Background(), "acl:"+key).Result()
    if err == redis.Nil {
        return nil, false // Cache miss
    }
    if err != nil {
        return nil, false // Error, treat as miss
    }
    
    // Parse the JSON list stored in Redis
    var perms []string
    json.Unmarshal([]byte(val), &perms)
    return perms, true
}

func (rc *RedisCache) Set(key string, perms []string) {
    // Store as JSON in Redis
    data, _ := json.Marshal(perms)
    rc.client.Set(context.Background(), "acl:"+key, data, 24*time.Hour)
}

func (rc *RedisCache) Invalidate(key string) {
    rc.client.Del(context.Background(), "acl:"+key)
}

// Use it
cache := &RedisCache{client: redisClient}
engine, err := acl.New(ctx, db, &acl.Config{
    SubjectFunc: subjectFunc,
    Cache: cache,
})
```

Now all processes using the same Redis instance share the cache. When one process calls `engine.Grant`, it invalidates the entry on Redis, and the next check on any process reloads from the database.

### Thread safety

The built-in memory cache is thread-safe for concurrent reads and writes. If you implement a custom cache, make sure it is thread-safe — the engine calls `Get`, `Set`, and `Invalidate` concurrently from multiple goroutines.

### Copy semantics

The built-in cache copies the permission slice on `Get` and `Set`, so callers cannot accidentally modify the stored list. If you implement a custom cache, consider doing the same to prevent bugs.

---

## Configuration summary

| Config | Behavior |
|---|---|
| No `DisableCache`, no `Cache` field | Built-in memory cache (recommended for single process) |
| `Cache` set to your implementation | Use your custom cache (e.g., Redis for multi-process) |
| `DisableCache: true` | No cache; database on every check (if `Cache` is also set, it is ignored) |

### When to use which

**Built-in memory cache:** Single-process apps, monoliths, or when per-process caching is acceptable. Zero setup, very fast.

**Custom cache (e.g., Redis):** Multiple processes that need to share permissions instantly. Higher latency per check but synchronized across instances.

**No cache:** Permissions change constantly, database is fast, or you need perfect consistency even within a single request.

Most applications use the built-in memory cache and never need to change it.
