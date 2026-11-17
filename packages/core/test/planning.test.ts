import { AdapterRegistry, type LotseError, planResources, resolveRuntime, suitableAdapters } from "../src/index.js";
import { fakeAdapter, fakeResourceAdapter, manifest, serverManifest } from "./helpers.js";

function caught(fn: () => unknown): LotseError {
  try {
    fn();
  } catch (err) {
    return err as LotseError;
  }
  throw new Error("expected an error");
}

describe("runtime resolution", () => {
  const platform = fakeAdapter({ runtimes: ["static", "server"], languages: ["node"] }, "platform");
  const containers = fakeAdapter({ runtimes: ["server", "container"], languages: ["node", "python", "go"] }, "containers");
  const registry = new AdapterRegistry().registerHosting(platform).registerHosting(containers);

  it("accepts runtimes the adapter reports", () => {
    expect(resolveRuntime(manifest(serverManifest), platform, registry)).toEqual({ runtime: "server", containerized: false, notes: [] });
  });

  it("packages static sites into a container where there is no static hosting", () => {
    const r = resolveRuntime(manifest("version: 1\nname: site\nruntime:\n  kind: static\n"), containers, registry);
    expect(r).toMatchObject({ runtime: "container", containerized: true });
    expect(r.notes[0]).toMatch(/packaged into a small web server image/);
  });

  it("rejects containers on platforms without a container runtime and suggests alternatives", () => {
    const err = caught(() => resolveRuntime(manifest("version: 1\nname: box\nruntime:\n  kind: container\n"), platform, registry));
    expect(err.code).toBe("RUNTIME_UNSUPPORTED");
    expect(err.hints.join(" ")).toContain("Fake (containers)");
  });

  it("checks the language on platforms without a container runtime", () => {
    const python = manifest("version: 1\nname: api\nruntime:\n  kind: server\n  language: python\n");
    const err = caught(() => resolveRuntime(python, platform, registry));
    expect(err.code).toBe("LANGUAGE_UNSUPPORTED");
    expect(err.message).toContain("does not run python server apps");
    expect(err.hints.join(" ")).toContain("Fake (containers)");
    // A container runtime runs any language.
    expect(resolveRuntime(python, containers, registry).runtime).toBe("server");
    expect(suitableAdapters(python, registry).map((a) => a.id)).toEqual(["containers"]);
  });

  it("rejects custom domains where they are unsupported", () => {
    const noDomains = fakeAdapter({ customDomains: false }, "nodomains");
    const err = caught(() => resolveRuntime(manifest(`${serverManifest}domains:\n  - app.example.com\n`), noDomains, registry));
    expect(err.code).toBe("DOMAINS_UNSUPPORTED");
  });
});

describe("resource planning", () => {
  const withDb = manifest(`${serverManifest}resources:\n  - type: postgres\n    name: db\n`);

  it("uses the hosting provider when it offers the resource", () => {
    const adapter = fakeAdapter({ resources: ["postgres"] });
    adapter.provision = async () => ({ type: "postgres", name: "db", id: "1", provider: "fake", env: [] });
    const registry = new AdapterRegistry().registerHosting(adapter).registerResource(fakeResourceAdapter());
    expect(planResources({ manifest: withDb, adapter, registry, connectedProviders: ["fakedb"], existing: [] })).toEqual([
      { spec: { type: "postgres", name: "db" }, provider: "fake", native: true, action: "create" },
    ]);
  });

  it("proposes an external provider when the hosting provider lacks the resource", () => {
    const adapter = fakeAdapter();
    const registry = new AdapterRegistry().registerHosting(adapter).registerResource(fakeResourceAdapter());
    expect(planResources({ manifest: withDb, adapter, registry, connectedProviders: ["fakedb"], existing: [] })[0]).toMatchObject({
      provider: "fakedb",
      native: false,
      action: "create",
    });
    const err = caught(() => planResources({ manifest: withDb, adapter, registry, connectedProviders: [], existing: [] }));
    expect(err.code).toBe("RESOURCE_UNSUPPORTED");
    expect(err.message).toContain("sign in to Fake DB (`lotse connect fakedb`)");
    expect(err.details.proposals).toEqual(["fakedb"]);
  });

  it("stops with a clear message when nobody provides the resource", () => {
    const adapter = fakeAdapter();
    const withStorage = fakeAdapter({ resources: ["postgres"] }, "other");
    const registry = new AdapterRegistry().registerHosting(adapter).registerHosting(withStorage);
    const err = caught(() => planResources({ manifest: withDb, adapter, registry, connectedProviders: [], existing: [] }));
    expect(err.code).toBe("RESOURCE_UNSUPPORTED");
    expect(err.message).toContain("no installed resource adapter provides it");
    expect(err.hints[0]).toContain("Fake (other)");
  });

  it("reuses resources that already exist", () => {
    const adapter = fakeAdapter();
    const registry = new AdapterRegistry().registerHosting(adapter);
    const existing = [{ type: "postgres", name: "db", id: "db-1", provider: "fakedb", envNames: ["DATABASE_URL"] }];
    expect(planResources({ manifest: withDb, adapter, registry, connectedProviders: [], existing })[0]).toMatchObject({ action: "reuse", provider: "fakedb" });
  });
});
