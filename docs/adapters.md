# Writing an adapter

An adapter connects Lotse to one provider. There are three kinds, all defined in [`packages/core/src/types.ts`](../packages/core/src/types.ts):

- **`HostingAdapter`** deploys apps: `connect`, `verify`, `plan`, `deploy` (a stream of events), `rollback`, `destroy`, `status`, `logs`, `setEnv`, optionally `addDomain`, `provision` for resources the host offers itself, `server` (approved setup of own servers) and `backups`.
- **`GitProvider`** stores code: `connect`, `listRepos`, `createRepo`, `remoteUrl`, optionally `setCiSecret`, `writeWorkflow`, `comment` and `pages` (a hosting adapter for its Pages service).
- **`ResourceAdapter`** provides a resource from elsewhere, e.g. a Postgres database: `connect`, `verify`, `provision`, `destroy`, `status`.

Adapters are regular npm packages named `lotse-adapter-<name>` or published in the `@lotse/` scope. The default export is an `AdapterPackage`:

```ts
import { ADAPTER_API_VERSION, type AdapterPackage } from "@lotse/core";

const pkg: AdapterPackage = { apiVersion: ADAPTER_API_VERSION, hosting: createAcmeAdapter };
export default pkg;
```

An instance loads it by name through its configuration (`LOTSE_ADAPTERS=lotse-adapter-acme`, or `adapters` in the CLI's `config.json` or the project's `.lotse/config.json`); restarting is enough.

## Start with the generator

```sh
lotse create adapter acme --display-name "Acme Cloud"
cd lotse-adapter-acme && npm install && npm test
```

The generated package contains a small working adapter for an example API, a cassette of recorded responses and the contract tests, which pass as generated. Replace the example API with the provider's real one step by step, keeping the tests green.

## Rules every adapter follows

- **Capabilities are honest.** `capabilities` lists the runtimes, languages and resources the provider supports, whether it supports custom domains and preview deployments, and how it rolls back (`native`, `redeploy` or `none`). The engine and the builder hide or replace what an adapter does not report, and propose alternatives.
- **Credentials stay in the connection.** `connect` returns a `Connection`: `credentials` are secret, `settings` are not. Never log credentials or put them into `settings`, `meta`, events or error messages. Use `HttpClient` from the core, which scrubs known secrets from errors.
- **Sign-in methods are declared, not implemented.** List `auth` (`oauth`, `token`, `ssh`), an `oauth` configuration (endpoints, scopes, `envPrefix`) and a `tokenSetup` guide (link to the token page, exact permissions, steps). The core runs the OAuth flow and hands the adapter finished tokens.
- **Deployments stream events.** `deploy` yields `log`, `progress` and `status` events and ends with `status("deploy", "succeeded", url, deployment)`. The engine performs the health check and rolls back on failure.
- **Nothing is destroyed implicitly.** `destroy` removes the app; resources at external providers are only removed when the user asks. Setting up a server requires `approved: true`.
- **Missing things are `NOT_FOUND`.** Use `LotseError` codes so that the engine can react: `AUTH_FAILED`, `PERMISSION_MISSING`, `NOT_FOUND`, `CONFLICT`, `RUNTIME_UNSUPPORTED`, …

## Testing

Every adapter must pass the shared contract suite from `@lotse/adapter-testkit`, on every pull request:

```ts
import { loadCassette, runHostingContract } from "@lotse/adapter-testkit";

const cassette = await loadCassette(new URL("./cassette.json", import.meta.url));

runHostingContract({
  cassette,
  create: (scenario) => createAcmeAdapter({ fetch: scenario.fetch }),
  connectInput: { method: "token", token: "acme-test-token-123456" },
  invalidConnectInput: { method: "token", token: "wrong-token-000000" },
  manifest: "version: 1\nname: lotse-reference\nruntime:\n  kind: static\n",
  fixtures: { appId: "site_1", previousDeployment: { id: "dep_0" } },
});
```

The suite runs scenarios against the cassette: sign-in with valid and invalid credentials, verify, plan, deploy, a failed deployment, status, logs, environment variables, domains, rollback and destroy. It checks that credentials never leak into events, metadata or errors, that every recorded interaction was used, and that state-changing scenarios really change state. `runGitContract` and `runResourceContract` do the same for the other kinds.

A cassette lists request and response pairs per scenario. URLs may use `*` for one path segment; a request body in the cassette must be contained in the real one. Several entries for the same request are answered in order, the last one repeatedly (polling).

### Recording real responses

Cassettes are best recorded from the real API. Add a live test that deploys the reference app with a test account:

```ts
import { liveTransport, runLiveDeployment } from "@lotse/adapter-testkit";

const transport = liveTransport("acme");

runLiveDeployment({
  transport,
  adapter: createAcmeAdapter({ fetch: transport.fetch }),
  app: "static",
  connect: (env) => (env.LOTSE_LIVE_ACME_TOKEN ? { method: "token", token: env.LOTSE_LIVE_ACME_TOKEN } : undefined),
});
```

It is skipped without credentials. Run it with `LOTSE_RECORD=<folder>` to write every interaction, with credentials scrubbed, to `<folder>/acme.live.json`, and copy the relevant interactions into the scenarios of `test/cassette.json`. Mark the cassette `"source": "live"` with `recordedAt`.

Live tests run nightly and before every release. If an adapter's live tests fail two nights in a row, an issue is opened for its maintainers.

## Versioning

`apiVersion` states which version of the adapter interface the adapter implements. The interface follows Semantic Versioning: breaking changes only in a new major version, and anything that will be removed is marked as deprecated at least one minor version in advance. Adapters are versioned independently of the core.
