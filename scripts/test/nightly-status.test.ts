// @ts-expect-error -- plain JavaScript module without type declarations
import { needsIssue, nextStatus, statusPage } from "../nightly-status.mjs";

describe("nightly status", () => {
  const night = (n: number) => `2026-11-${String(10 + n).padStart(2, "0")}T03:00:00Z`;

  it("opens an issue only after two failed nights in a row", () => {
    let status = nextStatus(
      undefined,
      [
        { suite: "vercel", ok: false, url: "https://ci/1" },
        { suite: "ssh-ubuntu", ok: true },
      ],
      night(1),
    );
    expect(needsIssue(status)).toEqual([]);
    status = nextStatus(
      status,
      [
        { suite: "vercel", ok: false, url: "https://ci/2" },
        { suite: "ssh-ubuntu", ok: true },
      ],
      night(2),
    );
    expect(needsIssue(status)).toEqual([{ suite: "vercel", consecutiveFailures: 2, lastSuccess: null, url: "https://ci/2" }]);
    // A success ends the streak and is shown as the last successful run.
    status = nextStatus(status, [{ suite: "vercel", ok: true }], night(3));
    expect(status.suites.vercel).toMatchObject({ ok: true, consecutiveFailures: 0, lastSuccess: night(3) });
    expect(status.suites["ssh-ubuntu"]).toMatchObject({ lastSuccess: night(2) });
  });

  it("does not count nights without credentials", () => {
    let status = nextStatus(undefined, [{ suite: "fly", ok: false }], night(1));
    status = nextStatus(status, [{ suite: "fly", ok: true, skipped: true }], night(2));
    expect(needsIssue(status)).toEqual([]);
    status = nextStatus(status, [{ suite: "fly", ok: false }], night(3));
    expect(needsIssue(status)).toEqual([expect.objectContaining({ suite: "fly", consecutiveFailures: 2 })]);
  });

  it("renders the status page without trusting its input", () => {
    const status = nextStatus(undefined, [{ suite: "<script>x</script>", ok: false, url: 'https://ci/"onload' }], night(1));
    const html = statusPage(status);
    expect(html).toContain("failing (1 night)");
    expect(html).not.toContain("<script>x");
    expect(html).not.toContain('"onload');
  });
});
