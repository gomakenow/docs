# Getting started

GoMakeNow is a **repo you scaffold**. Folders like `query/`, `storage/`, `mailing/`, `payment/`, and `discount/` are already in that repo — same Go module as your handlers. They are not something you `go get` and wire up from outside.

You write HTTP, auth, GORM models, admin UI, and product rules. You call the engines that shipped with the kit. You do not reimplement cursor pagination or a Stripe client.

## How to read this site

| Section | What it is |
|---|---|
| [Architecture](./architecture) | What you write vs what already lives in the kit folders |
| [Migrations](./migrations) | SQL under each kit folder, publish into `db/migrations/`, then migrate |
| [Packages](/packages/) | One page per folder. Filled in step by step |
| [Cookbook](/cookbook/) | New admin table, new provider, new driver |

Each package page:

1. What you write vs what that folder already does
2. How you call it from a handler
3. The recipe (copy-paste Go)
4. How to extend it (new column, new provider, new driver)

## What this site is not

- Not a dump of every Stripe HMAC or GORM quirk
- Not a particular product’s business rules (licenses, credits, checkout copy)

## Local docs

```bash
npm install
npm run docs:dev
```
