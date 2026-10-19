// Production Next server entry for vibehard's `app.command`.
//
// Why not `node node_modules/next/dist/bin/next start` directly in
// vibehard.config.json? This example is an npm-workspaces package, so
// `next` is hoisted to the repo-root node_modules and the relative path
// does not exist here. Resolving the bin through the module system
// works hoisted or standalone, and importing it keeps the Next CLI in
// *this* process, so Vibehard's signal ends the server (and flushes
// NODE_V8_COVERAGE) instead of a wrapper. Port comes from PORT env
// (vibehard substitutes {port}).
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const nextPackageJson = require.resolve("next/package.json");
const bin = path.join(path.dirname(nextPackageJson), "dist/bin/next");

process.argv = [
  process.argv[0] ?? "node",
  bin,
  "start",
  "-p",
  process.env["PORT"] ?? "3000",
  "-H",
  "127.0.0.1",
];

await import(bin);
