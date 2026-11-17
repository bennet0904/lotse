#!/usr/bin/env node
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { errorMessage, isLotseError } from "@lotse/core";
import { configFromEnv } from "./config.js";
import { createLotseServer } from "./server.js";

try {
  // The web UI is served from the same process when its build is present next to the server.
  const bundledUi = [process.env.LOTSE_UI_DIR, fileURLToPath(new URL("../../ui/dist", import.meta.url)), fileURLToPath(new URL("../ui", import.meta.url))].find(
    (dir) => dir && existsSync(dir),
  );
  const config = configFromEnv(process.env, { uiDir: bundledUi });
  const server = await createLotseServer(config);
  const address = await server.listen();
  console.log(`Lotse is running at ${config.publicUrl} (listening on ${address})`);
  console.log(`  database: ${config.databaseUrl.replace(/\/\/[^@]*@/, "//…@")}`);
  console.log(`  sign-in:  ${config.auth === "oidc" ? `OpenID Connect (${config.oidc?.issuer})` : "none (single user)"}`);
  const stop = () => {
    console.log("Stopping…");
    void server.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
} catch (err) {
  console.error(`Lotse could not start: ${errorMessage(err)}`);
  if (isLotseError(err)) for (const hint of err.hints) console.error(`  ${hint}`);
  process.exit(1);
}
