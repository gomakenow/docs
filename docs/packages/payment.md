# payment

Providers, persistence, webhook verification, catalog links, and refunds. Lives at `payment/` in the scaffolded repo.

::: info Next
This page is a scaffold.
:::

## What you write vs what `payment/` does

`payment/` talks to providers and persists payment / refund / catalog rows. You write HTTP, checkout settings, fulfillment, and eligibility (who may pay, who may refund).

## Call it from your app

Call `payment.Gateway`. Publish payment SQL, then [FK / id-type edits](/guide/migrations) if your catalog PKs are not bigint.

## Recipe

`gateway.Create`, `SyncStatus`, `Refund`. You register webhook routes; `payment/` verifies and normalizes.

## Adding a provider

A new provider implements the provider contract and is registered on `DefaultGateway`. Cookbook: [New payment provider](/cookbook/new-payment-provider).
