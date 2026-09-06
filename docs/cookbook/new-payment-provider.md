# New payment provider

Adding a fifth rail (beyond Stripe, Lemon Squeezy, NowPayments, and wallet) is documented with the payment package: implement `providers.Provider`, register it on `DefaultGateway`, load env, and verify webhooks. You still write the HTTP route, checkout toggle, and fulfillment.

See [Providers → Adding a new provider](/packages/payment/providers#adding-a-new-provider).
