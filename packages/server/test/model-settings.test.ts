/** Language-model settings made in the user interface, as the desktop app needs them. */
import { rm } from "node:fs/promises";
import { startTestServer, type TestServer } from "./helpers.js";

describe("language-model settings", () => {
  let t: TestServer;

  beforeAll(async () => {
    t = await startTestServer({ env: { OPENAI_API_KEY: "sk-from-environment-0000" } });
  });
  afterAll(async () => {
    await t.server.close();
    await rm(t.dataDir, { recursive: true, force: true });
  });

  it("stores keys encrypted and never returns them", async () => {
    const saved = await t.api<Record<string, { value: string | null; configured: boolean; source: string | null }>>("PUT", "/settings/models", {
      defaultModel: "ollama:qwen3-coder",
      anthropicKey: "sk-ant-settings-key-0000000000",
      ollamaUrl: "http://192.168.1.20:11434",
    });
    expect(saved.status).toBe(200);
    expect(saved.body.anthropicKey).toEqual({ value: null, configured: true, source: "settings" });
    expect(saved.body.openaiKey).toEqual({ value: null, configured: true, source: "environment" });
    expect(saved.body.defaultModel).toEqual({ value: "ollama:qwen3-coder", configured: true, source: "settings" });
    expect(saved.body.compatibleKey).toEqual({ value: null, configured: false, source: null });
    const read = await t.api("GET", "/settings/models");
    expect(JSON.stringify(read.body)).not.toContain("sk-ant-settings-key");
    // Encrypted at rest.
    const { db, schema } = t.server.services.database;
    const rows = await db.select().from(schema.secrets);
    expect(JSON.stringify(rows)).not.toContain("sk-ant-settings-key");
  });

  it("is what model calls use, over the environment", async () => {
    const env = await t.server.services.models.env();
    expect(env).toMatchObject({
      ANTHROPIC_API_KEY: "sk-ant-settings-key-0000000000",
      OPENAI_API_KEY: "sk-from-environment-0000",
      OLLAMA_BASE_URL: "http://192.168.1.20:11434",
      LOTSE_MODEL: "ollama:qwen3-coder",
    });
    const model = await t.server.services.resolveModel(undefined);
    expect(model).toMatchObject({ id: "ollama:qwen3-coder", local: true });
    expect((await t.api<{ models: { implement: string } }>("GET", "/config")).body.models.implement).toBe("ollama:qwen3-coder");
  });

  it("removes a value with an empty string and checks what is entered", async () => {
    const cleared = await t.api<Record<string, { configured: boolean }>>("PUT", "/settings/models", { anthropicKey: "" });
    expect(cleared.body.anthropicKey?.configured).toBe(false);
    expect((await t.api<{ error: { code: string } }>("PUT", "/settings/models", { defaultModel: "gpt" })).body.error.code).toBe("INVALID_INPUT");
    expect((await t.api<{ error: { code: string } }>("PUT", "/settings/models", { ollamaUrl: "file:///etc" })).body.error.code).toBe("INVALID_INPUT");
    const audit = await t.api<{ entries: { action: string }[] }>("GET", "/audit");
    expect(audit.body.entries.filter((e) => e.action === "model-settings.changed").length).toBe(2);
  });
});
