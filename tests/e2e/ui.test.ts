/**
 * The web UI in a real browser, against the builder server with a scripted
 * model, a real sandbox and an in-memory provider. Needs a container engine
 * and Playwright's Chromium; skipped otherwise.
 */
import { mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { scriptedModel } from "@lotseai/agent";
import { AdapterRegistry } from "@lotseai/core";
import { DockerClient } from "@lotseai/sandbox";
import fake, { baseUrl, provider } from "../../packages/cli/test/fixtures/fake-adapter.js";
import { startTestServer, type TestServer } from "../../packages/server/test/helpers.js";

type Playwright = typeof import("playwright");
const playwright = await (async (): Promise<Playwright | undefined> => {
  try {
    return createRequire(import.meta.url)("playwright") as Playwright;
  } catch {
    return undefined;
  }
})();
const docker = await new DockerClient().ping().then(
  () => true,
  () => false,
);
const uiDir = fileURLToPath(new URL("../../packages/ui/dist", import.meta.url));
const shots = process.env.LOTSE_SCREENSHOT_DIR;

const plan = {
  stack: "static",
  name: "todo-list",
  title: "Todo List",
  summary: "A list of tasks that can be checked off.",
  dataModel: [{ entity: "Task", fields: ["title: text", "done: boolean"] }],
  pages: [{ name: "Home", purpose: "Shows the tasks" }],
  resources: [],
  notes: ["Tasks are kept in the browser."],
};
const page = (heading: string) =>
  `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>Todo List</title><link rel="stylesheet" href="styles.css"></head>\n<body><main><h1>${heading}</h1><ul><li>Buy milk</li><li>Write tests</li></ul></main></body>\n</html>\n`;

describe.skipIf(!playwright || !docker)("builder UI", () => {
  let t: TestServer;
  let browser: import("playwright").Browser;
  let ui: import("playwright").Page;

  const shot = async (name: string) => {
    if (!shots) return;
    await mkdir(shots, { recursive: true });
    await ui.screenshot({ path: `${shots}/${name}.png` });
  };

  beforeAll(async () => {
    provider.reset();
    const model = scriptedModel([
      { text: `\`\`\`json\n${JSON.stringify(plan)}\n\`\`\`` },
      { text: "I will write the page.", toolCalls: [{ name: "write_file", input: { path: "index.html", content: page("My tasks") } }] },
      { text: "I built a todo list with two example tasks." },
      { toolCalls: [{ name: "edit_file", input: { path: "index.html", old_text: "<h1>My tasks</h1>", new_text: "<h1>Things to do</h1>" } }] },
      { text: "The heading now says “Things to do”." },
    ]);
    t = await startTestServer({ uiDir }, { resolveModel: async () => model, registry: new AdapterRegistry().use(fake) });
    browser = await (playwright as Playwright).chromium.launch();
    ui = await browser.newPage({ viewport: { width: 1360, height: 860 }, locale: "en-US" });
    // Preview addresses are p-….localhost on the server's port; Chromium resolves *.localhost itself.
    await ui.goto(t.url.replace("127.0.0.1", "localhost"));
  });

  afterAll(async () => {
    await browser?.close();
    await t?.server.services.sandboxes.shutdown({ removeGateway: true });
    await t?.server.close();
    if (t) await rm(t.dataDir, { recursive: true, force: true });
  });

  let n = 0;
  afterEach(async () => {
    await shot(`after-${++n}`);
  });

  it("starts with the prompt and is operable by keyboard", async () => {
    await ui.getByRole("heading", { name: "What do you want to build?" }).waitFor();
    expect(await ui.evaluate(() => document.documentElement.lang)).toBe("en");
    // The first Tab stop is the skip link.
    await ui.keyboard.press("Tab");
    expect(await ui.evaluate(() => document.activeElement?.textContent)).toBe("Skip to content");
    await shot("01-start");
  });

  it("goes from a prompt to a reviewed plan to a running preview", async () => {
    await ui.getByLabel("Describe your app").fill("A simple todo list");
    await ui.getByRole("button", { name: "Plan the app" }).click();
    await ui.getByRole("heading", { name: "Plan", exact: true }).waitFor();
    await expectText("A list of tasks that can be checked off.");
    await shot("02-plan");

    await ui.getByRole("button", { name: "Build it" }).click();
    await ui.getByText("I built a todo list with two example tasks.").waitFor({ timeout: 120_000 });
    const frame = ui.frameLocator("iframe");
    await frame.getByRole("heading", { name: "My tasks" }).waitFor({ timeout: 60_000 });
    await shot("03-preview");
  });

  it("changes the app from the chat and lists the versions", async () => {
    await ui.getByLabel("Describe a change").fill("Call the heading “Things to do”");
    await ui.getByRole("button", { name: "Send" }).click();
    await ui.getByText("The heading now says “Things to do”.").waitFor({ timeout: 120_000 });
    await ui.frameLocator("iframe").getByRole("heading", { name: "Things to do" }).waitFor({ timeout: 60_000 });

    await ui.getByRole("tab", { name: "Versions" }).click();
    await ui.getByText("Scaffold Static site project").waitFor();
    expect(await ui.locator(".versions li").count()).toBe(3);
    await ui.getByRole("tab", { name: "Files" }).click();
    await ui.getByRole("button", { name: "index.html" }).click();
    await expectText("<h1>Things to do</h1>");
    await ui.getByRole("tab", { name: "Usage" }).click();
    await ui.getByRole("rowheader", { name: "scripted:fixed" }).waitFor();
    await shot("04-usage");
  });

  it("connects a provider through the guided token setup", async () => {
    await ui.getByRole("link", { name: "Providers" }).click();
    await ui.getByRole("button", { name: "Connect Fake Cloud" }).click();
    await ui.getByText("Required permissions:").waitFor();
    await shot("05-connect");
    await ui.getByLabel("Token").fill("fake-token-123456");
    await ui.getByRole("dialog").getByRole("button", { name: "Connect", exact: true }).click();
    await ui.getByRole("dialog").getByText("Connected.").waitFor();
    await ui.getByRole("button", { name: "Done" }).click();
    await ui.getByText("Fake Cloud", { exact: true }).first().waitFor();
    // The token is never rendered again.
    expect(await ui.content()).not.toContain("fake-token-123456");
  });

  it("publishes with one click after the first deployment was approved", async () => {
    await ui.getByRole("link", { name: "Apps" }).click();
    await ui.getByRole("link", { name: "Todo List" }).click();
    await ui.getByRole("tab", { name: "Publish" }).click();
    await ui.getByRole("button", { name: "Check what will happen" }).click();
    await ui.getByText("First deployment to Fake Cloud").waitFor();
    await ui.getByRole("button", { name: "Publish", exact: true }).click();
    // Nothing is deployed until the dialog is confirmed.
    await ui.getByRole("heading", { name: "Publish for the first time?" }).waitFor();
    expect(provider.apps.size).toBe(0);
    await shot("06-approve");
    await ui.getByRole("button", { name: "Yes, publish" }).click();
    await ui.getByText("Your app is live:").waitFor({ timeout: 120_000 });
    await ui
      .getByRole("link", { name: `${baseUrl}/?app=todo-list` })
      .first()
      .waitFor();
    expect(provider.apps.get("todo-list")?.live).toBe("dep-1");
    await shot("07-published");
  });

  it("has labels on all form controls and switches to German", async () => {
    const unlabeled = await ui.evaluate(() =>
      [...document.querySelectorAll("input, select, textarea")]
        .filter((el) => {
          const e = el as HTMLInputElement;
          return !(e.labels?.length || e.getAttribute("aria-label") || e.getAttribute("aria-labelledby"));
        })
        .map((el) => el.outerHTML.slice(0, 80)),
    );
    expect(unlabeled).toEqual([]);
    expect(await ui.locator("h1").count()).toBe(1);

    await ui.getByLabel("Language").selectOption("de");
    await ui.getByRole("link", { name: "Anbieter" }).waitFor();
    expect(await ui.evaluate(() => document.documentElement.lang)).toBe("de");
    await ui.getByRole("link", { name: "Einstellungen" }).click();
    await ui.getByText("Keine. Es wird nichts an das Projekt oder andere gesendet.").waitFor();
    await shot("08-settings-de");
  });

  async function expectText(text: string) {
    await ui.getByText(text, { exact: false }).first().waitFor();
  }
});
