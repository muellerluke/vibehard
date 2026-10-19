// Bundle the plain Node server and the browser client (with source
// maps — vibehard fails closed without them). Run: `node build.mjs`.
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const outdir = path.join(here, ".build");
const shared = { bundle: true, format: "esm", sourcemap: true, logLevel: "silent" };

await build({
  ...shared,
  entryPoints: [path.join(here, "src/server.ts")],
  outfile: path.join(outdir, "server.mjs"),
  platform: "node",
});
await build({
  ...shared,
  entryPoints: [path.join(here, "src/client.ts")],
  outfile: path.join(outdir, "client.mjs"),
  platform: "browser",
});
