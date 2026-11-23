# Secrets and settings

Apps often need values that must not be part of their code: an API key of a payment service, a password for sending e-mail, a key for signing sessions.

## Secrets

The language model declares the secrets an app needs (by name, e.g. `MAIL_PASSWORD`) in the app's `lotse.yaml`, and writes the code to read them from environment variables. The values come from you:

- **When publishing:** Lotse asks for every secret that has no value yet, below the plan.
- **Later:** in the **Publish** tab, under **Secrets**, each secret shows whether it is _set_ or _not set_. Enter a new value and choose **Save new values**. Publish again for the app to use it.

Secret values are encrypted, never shown again, never written to logs and never given to the language model. Lotse passes them to the provider as encrypted environment variables where the provider has them.

To ask for a new secret, tell the model, e.g. _"Send the sign-up confirmation by e-mail; the SMTP password should be a secret."_

## Settings that are not secret

Values that may be visible, such as a log level or a public URL, are written into `lotse.yaml` under `env.public` and are part of the code. Change them by asking the model or in the linked repository.

## Values that Lotse sets

| Variable       | Value                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------ |
| `PORT`         | The port the app must listen on                                                            |
| `DATABASE_URL` | The address of the app's Postgres database named `db` (other names: `<NAME>_DATABASE_URL`) |
| `REDIS_URL`    | The address of the app's Redis named `redis` or `cache`                                    |
