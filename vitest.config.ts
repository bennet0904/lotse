import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

// Tests run against the TypeScript sources, so no build is needed first.
const alias = [{ find: /^@lotseai\/(?!ui$)([a-z0-9-]+)$/, replacement: `${root}packages/$1/src/index.ts` }];

const shared = { resolve: { alias }, test: { globals: true, environment: "node" as const } };

export default defineConfig({
  test: {
    projects: [
      // Core, manifest validation, planning logic. On every pull request.
      {
        ...shared,
        test: {
          ...shared.test,
          name: "unit",
          include: ["packages/*/test/**/*.test.ts", "scripts/test/**/*.test.ts"],
          exclude: ["**/*.contract.test.ts", "**/*.integration.test.ts", "**/*.live.test.ts", "**/*.ssh.test.ts"],
        },
      },
      // Shared suite every adapter must pass, against recorded API responses. On every pull request.
      { ...shared, test: { ...shared.test, name: "contract", include: ["packages/*/test/**/*.contract.test.ts"] } },
      // Needs local Docker and Git, but no provider accounts.
      {
        ...shared,
        test: {
          ...shared.test,
          name: "integration",
          include: ["packages/*/test/**/*.integration.test.ts"],
          testTimeout: 180_000,
          hookTimeout: 180_000,
          fileParallelism: false,
        },
      },
      // Real deployments with test accounts. Nightly and before every release.
      {
        ...shared,
        test: {
          ...shared.test,
          name: "live",
          include: ["packages/*/test/**/*.live.test.ts"],
          testTimeout: 900_000,
          hookTimeout: 900_000,
          fileParallelism: false,
        },
      },
      // Setup and deployment on fresh Ubuntu and Debian machines. Nightly.
      {
        ...shared,
        test: {
          ...shared.test,
          name: "ssh",
          include: ["packages/*/test/**/*.ssh.test.ts"],
          testTimeout: 900_000,
          hookTimeout: 900_000,
          fileParallelism: false,
        },
      },
      // Prompt to deployment with a fixed model and fixed prompts. Before every release.
      {
        ...shared,
        test: { ...shared.test, name: "e2e", include: ["tests/e2e/**/*.test.ts"], testTimeout: 900_000, hookTimeout: 900_000, fileParallelism: false },
      },
    ],
  },
});
