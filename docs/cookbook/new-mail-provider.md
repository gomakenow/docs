# New mail provider

Adding a third outbound driver (beyond Mailgun and Mailtrap) is documented with the mailing package: implement `providers.Provider`, wire it in `NewGateway`, and select it with `MAIL_PROVIDER`.

See [Providers → Adding a new provider](/packages/mailing/providers#adding-a-new-provider).
