# lotse-adapter-**ID**

Lotse hosting adapter for **DISPLAY**.

This package was created with `lotse create adapter __ID__`. It contains a
small working adapter for an example API and the shared contract tests, which
pass as generated:

```sh
npm install
npm test
```

## Making it yours

1. Replace the endpoints in `src/index.ts` with the real API of **DISPLAY**.
2. Set `capabilities` to what the provider can actually do. The builder and
   the engine hide or replace everything an adapter does not report.
3. Record real API responses into `test/cassette.json`
   (run the live test with `LOTSE_RECORD=<folder>`, see `liveTransport` in `@lotseai/adapter-testkit`) and keep
   the contract tests green. Every adapter MUST pass them.
4. Add a live test that deploys the reference app with a test account.

## Using it

An instance loads adapters through its configuration; restarting is enough:

```sh
npm install lotse-adapter-__ID__
LOTSE_ADAPTERS=lotse-adapter-__ID__ lotse adapters
```

The adapter interface follows Semantic Versioning. `apiVersion` in the default
export states which version of the interface this adapter was written for.
