# discount

Vouchers, referrals, per-product rates, and immutable per-line payment snapshots. Lives at `discount/` in the scaffolded repo.

::: info Next
This page is a scaffold.
:::

## What you write vs what `discount/` does

`discount/` owns discount tables and apply/fulfill snapshots. You write auto-apply priority, landing banners, and checkout UX.

## Call it from your app

Publish discount SQL, then the FK file (and [id-type edits](/guide/migrations) if your PKs are not bigint).

## Recipe

## Adding a brick
