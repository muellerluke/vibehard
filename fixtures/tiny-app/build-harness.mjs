// Bundle the Stage 2 harness (server + client) for the Stage 3 e2e
// fixture. Run from this directory: `node build-harness.mjs [outdir]`.
// Set VH_NO_SOURCEMAP=1 to build without source maps (fail-closed tests).
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const outdir = path.resolve(process.cwd(), process.argv[2] ?? ".build");
const sourcemap = process.env["VH_NO_SOURCEMAP"] !== "1";
const shared = { bundle: true, format: "esm", sourcemap, logLevel: "silent" };

await build({
  ...shared,
  entryPoints: [path.join(here, "harness/server.ts")],
  outfile: path.join(outdir, "server.mjs"),
  platform: "node",
  jsx: "automatic",
});
await build({
  ...shared,
  entryPoints: [path.join(here, "harness/client.ts")],
  outfile: path.join(outdir, "client.mjs"),
  platform: "browser",
});
