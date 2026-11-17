import { liveTransport, runLiveDeployment } from "@lotseai/adapter-testkit";
import type { HostingAdapter } from "@lotseai/core";
import { createHetznerAdapter, deleteHetznerServer } from "../src/index.js";

const transport = liveTransport("hetzner");

// Needs LOTSE_LIVE_HETZNER_TOKEN of a test project. The test creates a server (billed by the hour) and deletes it again.
const adapter = createHetznerAdapter({ fetch: transport.fetch });
const setup = adapter.server as NonNullable<HostingAdapter["server"]>;

runLiveDeployment({
  transport,
  adapter,
  app: "server",
  connect: (env) =>
    env.LOTSE_LIVE_HETZNER_TOKEN
      ? {
          method: "token",
          token: env.LOTSE_LIVE_HETZNER_TOKEN,
          options: {
            serverName: `lotse-live-${Date.now().toString(36)}`,
            serverType: env.LOTSE_LIVE_HETZNER_TYPE ?? "cx22",
            location: env.LOTSE_LIVE_HETZNER_LOCATION ?? "nbg1",
          },
        }
      : undefined,
  async prepare(connection) {
    const plan = await setup.planSetup(connection);
    const run = setup.runSetup(connection, plan, { approved: true });
    for (;;) {
      const step = await run.next();
      if (step.done) return step.value;
    }
  },
  cleanup: (connection) => deleteHetznerServer(connection),
});
