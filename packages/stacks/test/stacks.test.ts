import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseManifest } from "@lotseai/core";
import { builtInStacks, StackRegistry, scaffoldFiles } from "../src/index.js";

describe("stack templates", () => {
  it("covers the stacks version 1.0 promises", () => {
    const byLanguage = (l: string) => builtInStacks.filter((s) => s.language === l).map((s) => s.id);
    expect(byLanguage("html")).toEqual(["static"]);
    expect(byLanguage("typescript")).toEqual(["react-vite", "nextjs", "hono"]);
    expect(byLanguage("python")).toEqual(["fastapi", "django"]);
    expect(byLanguage("go")).toEqual(["go-nethttp"]);
    expect(byLanguage("php")).toEqual(["laravel"]);
    // Python, Go and PHP stay labelled beta until end-to-end tests have proven them.
    expect(
      builtInStacks
        .filter((s) => s.beta)
        .map((s) => s.language)
        .sort(),
    ).toEqual(["go", "php", "python", "python"]);
  });

  it.each(builtInStacks.map((s) => [s.id, s] as const))("%s produces a base project with a valid manifest", (_id, stack) => {
    const files = stack.files({ name: "customer-portal", title: "Customer Portal" });
    const manifest = parseManifest(files["lotse.yaml"] as string);
    expect(manifest.name).toBe("customer-portal");
    expect(manifest.runtime.kind).toBe(stack.runtime);
    if (stack.runtime !== "static") expect(manifest.runtime.healthcheck).not.toBe("");
    expect(stack.sandbox.dev).toBeTruthy();
    expect(stack.sandbox.port).toBeGreaterThan(0);
    expect(stack.guidance.length).toBeGreaterThan(50);
    expect(stack.description.length).toBeGreaterThan(20);
    for (const [path, content] of Object.entries(files)) {
      expect(path.startsWith("/") || path.includes(".."), path).toBe(false);
      expect(typeof content).toBe("string");
    }
    // Nothing in a generated app depends on the framework at runtime.
    expect(JSON.stringify(files)).not.toMatch(/@lotseai\//);
  });

  it("writes the files of a template", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lotse-stack-"));
    try {
      const written = await scaffoldFiles(new StackRegistry().get("react-vite"), dir, { name: "todo", title: "Todo" });
      expect(written).toContain("src/App.tsx");
      expect(await readFile(join(dir, "src/App.tsx"), "utf8")).toContain("<h1>Todo</h1>");
      expect(JSON.parse(await readFile(join(dir, "package.json"), "utf8")).name).toBe("todo");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("can be extended by community packages", async () => {
    const registry = new StackRegistry();
    const custom = { ...registry.get("static"), id: "astro", name: "Astro" };
    await registry.load(["lotse-stack-astro"], async () => ({ default: custom }));
    expect(registry.get("astro").name).toBe("Astro");
    expect(() => registry.get("nope")).toThrow(/There is no stack "nope"/);
    await expect(registry.load(["empty"], async () => ({}))).rejects.toThrow(/does not export a stack template/);
    expect(registry.allowedHosts()).toContain("codeload.github.com");
  });
});
