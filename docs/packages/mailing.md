# mailing

Outbound mail: providers, a database queue, and optional recipient tracking. Lives at `mailing/` in the scaffolded repo.

::: info Next
This page is a scaffold.
:::

## What you write vs what `mailing/` does

`mailing/` sends HTML you already rendered. You write routes, audiences, consent, and unsubscribe.

## Call it from your app

Publish mailing SQL into `db/migrations/`, then call `mailing.Engine` from your code.

## Recipe

`Queue` / `QueueBatch`. The worker talks to Mailgun or Mailtrap; the HTTP request does not.

## Adding a provider

A new provider file, registered on `DefaultGateway`.
