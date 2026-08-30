# storage

Local disk and S3 drivers. Public vs private objects and URLs. Lives at `storage/` in the scaffolded repo. No tables of its own.

::: info Next
This page is a scaffold.
:::

## What you write vs what `storage/` does

You write upload HTTP, image/video validation, and media database rows. `storage/` is the driver layer those handlers call.

## Call it from your app

## Recipe

## Adding a driver

A new object store registers next to local and S3.
