// Phase 4 delegation planner measurement (no framework processes):
// for synthetic selected sets, report the unchunked argv size and the
// chunked plan (chunk count, largest chunk) per framework, asserting
// every planned invocation stays within ARGV_BUDGET_BYTES.
// Usage: npm run build && node perf/delegation.mjs
import {
  ARGV_BUDGET_BYTES,
  argvBytes,
  encodeOnlyTitles,
  planCypressChunks,
  planPlaywrightChunks,
  planPuppeteerChunks,
} from "../dist/index.js";

function selectedSet(n) {
  const tests = [];
  for (let i = 0; i < n; i += 1) {
    const file = `e2e/spec-${String(Math.floor(i / 10)).padStart(3, "0")}.spec.ts`;
    const title = `representative test case ${i} does a thing`;
    tests.push({
      testId: `${file}::${title}`,
      file,
      line: 10 + (i % 10) * 5,
      title,
      titlePath: [`suite ${Math.floor(i / 10)}`, title],
    });
  }
  return tests;
}

for (const n of [100, 1000, 3000, 10000]) {
  const tests = selectedSet(n);
  // Half of each file selected in the discovered set (partial files),
  // so no whole-file collapse hides the per-test argument cost.
  const discovered = tests.flatMap((t) => [
    t,
    { ...t, testId: `${t.testId} (other)`, title: `${t.title} (other)` },
  ]);

  const pwUnchunked = argvBytes(tests.map((t) => `${t.file}:${t.line}`));
  const pw = planPlaywrightChunks(tests, discovered);
  const pwMax = Math.max(...pw.map((c) => argvBytes(c.positionals)));

  const cySpecs = [...new Set(tests.map((t) => t.file))];
  const cyUnchunked =
    argvBytes(["--spec", cySpecs.join(",")]) +
    Buffer.byteLength(encodeOnlyTitles(tests.map((t) => t.titlePath)));
  const cy = planCypressChunks(tests, discovered);
  const cyMax = Math.max(
    ...cy.map(
      (c) =>
        argvBytes(["--spec", c.specs.join(",")]) +
        (c.onlyTitles === null ? 0 : Buffer.byteLength(encodeOnlyTitles(c.onlyTitles))),
    ),
  );

  const pup = planPuppeteerChunks(tests, discovered);
  const pupMax = Math.max(
    ...pup.map((c) => (c.pattern === null ? 0 : argvBytes([`--test-name-pattern=${c.pattern}`]))),
  );

  for (const [name, max] of [["playwright", pwMax], ["cypress", cyMax], ["puppeteer", pupMax]]) {
    if (max > ARGV_BUDGET_BYTES) {
      throw new Error(`${name} chunk of ${max} bytes exceeds budget ${ARGV_BUDGET_BYTES} at ${n} tests`);
    }
  }
  const covered = (chunks) => chunks.reduce((s, c) => s + c.tests.length, 0);
  if (covered(pw) !== n || covered(cy) !== n || covered(pup) !== n) {
    throw new Error(`planner dropped tests at ${n}`);
  }
  console.log(
    JSON.stringify({
      tests: n,
      budget: ARGV_BUDGET_BYTES,
      playwright: { unchunkedBytes: pwUnchunked, chunks: pw.length, maxChunkBytes: pwMax },
      cypress: { unchunkedBytes: cyUnchunked, chunks: cy.length, maxChunkBytes: cyMax },
      puppeteer: { chunks: pup.length, maxPatternBytes: pupMax },
    }),
  );
}
console.log("delegation planner: all chunks within budget, all tests covered");
