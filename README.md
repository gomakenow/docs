# GoMakeNow Documentation

VitePress site for **GoMakeNow**, a Go boilerplate. After scaffold, `query/`, `storage/`, `mailing/`, `payment/`, and `discount/` are folders in that repo (same Go module) — not outside `go.mod` libraries.

## Local development

```bash
npm install
npm run docs:dev
```

Production build:

```bash
npm run docs:build
```

## Site map

```
Guide
  Getting started
  Architecture     your code vs kit folders
  Migrations       publish kit SQL into db/migrations

Packages
  query, storage, mailing, payment, discount

Cookbook
  New admin table
  New payment provider
  New mail provider
  New storage driver
```
