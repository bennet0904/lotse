#!/usr/bin/env node
/**
 * Nightly test report (specification section 14.2): combines tonight's results
 * of the live and SSH tests with the previous status, writes the status page
 * (status.json and index.html) and lists the adapters whose tests failed two
 * nights in a row, so that the workflow opens an issue for their maintainers.
 *
 *   node scripts/nightly-status.mjs <results-dir> <previous-status.json|-> <out-dir>
 *
 * Each file in <results-dir> is JSON: { "suite": "vercel", "ok": true, "url": "<run url>" }.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Tonight's results applied to the previous status. */
export function nextStatus(previous, results, now = new Date().toISOString()) {
  const suites = { ...(previous?.suites ?? {}) };
  for (const result of results) {
    const before = suites[result.suite] ?? { consecutiveFailures: 0, lastSuccess: null };
    suites[result.suite] = {
      ok: result.ok,
      skipped: Boolean(result.skipped),
      lastRun: now,
      lastRunUrl: result.url ?? null,
      lastSuccess: result.ok && !result.skipped ? now : before.lastSuccess,
      // A night without credentials neither breaks nor continues a streak.
      consecutiveFailures: result.skipped ? before.consecutiveFailures : result.ok ? 0 : before.consecutiveFailures + 1,
    };
  }
  return { updated: now, suites };
}

/** Suites that need an issue: failed exactly twice in a row tonight (later nights add comments to that issue). */
export function needsIssue(status, threshold = 2) {
  return Object.entries(status.suites)
    .filter(([, s]) => !s.ok && !s.skipped && s.consecutiveFailures >= threshold)
    .map(([suite, s]) => ({ suite, consecutiveFailures: s.consecutiveFailures, lastSuccess: s.lastSuccess, url: s.lastRunUrl }));
}

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function statusPage(status) {
  const rows = Object.entries(status.suites)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([suite, s]) => {
      const state = s.skipped ? "not run" : s.ok ? "passing" : `failing (${s.consecutiveFailures} ${s.consecutiveFailures === 1 ? "night" : "nights"})`;
      const run = s.lastRunUrl ? `<a href="${escapeHtml(s.lastRunUrl)}">last run</a>` : "";
      return `<tr><th scope="row">${escapeHtml(suite)}</th><td class="${s.skipped ? "skip" : s.ok ? "ok" : "fail"}">${escapeHtml(state)}</td><td>${s.lastSuccess ? escapeHtml(s.lastSuccess.slice(0, 10)) : "never"}</td><td>${run}</td></tr>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Lotse adapter status</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:48rem;margin:2rem auto;padding:0 1rem;color:#1d2433}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:.4rem .6rem;border-bottom:1px solid #d5d9e0}.ok{color:#126b2e}.fail{color:#a4161a;font-weight:600}.skip{color:#5b6475}</style></head>
<body><main><h1>Adapter status</h1>
<p>Results of the nightly live and SSH tests. Updated ${escapeHtml(status.updated)}.</p>
<table><thead><tr><th scope="col">Suite</th><th scope="col">State</th><th scope="col">Last successful run</th><th scope="col"></th></tr></thead>
<tbody>
${rows}
</tbody></table></main></body></html>
`;
}

async function main([resultsDir, previousPath, outDir]) {
  if (!resultsDir || !previousPath || !outDir) throw new Error("usage: nightly-status.mjs <results-dir> <previous-status.json|-> <out-dir>");
  const results = [];
  for (const file of (await readdir(resultsDir, { recursive: true })).filter((f) => f.endsWith(".json")).sort()) {
    results.push(JSON.parse(await readFile(join(resultsDir, file), "utf8")));
  }
  const previous = previousPath === "-" ? undefined : JSON.parse(await readFile(previousPath, "utf8").catch(() => "null"));
  const status = nextStatus(previous ?? undefined, results);
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "status.json"), `${JSON.stringify(status, null, 2)}\n`);
  await writeFile(join(outDir, "index.html"), statusPage(status));
  await writeFile(join(outDir, "issues.json"), `${JSON.stringify(needsIssue(status), null, 2)}\n`);
  console.log(`${results.length} results; ${needsIssue(status).length} suites failing two nights or more`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
