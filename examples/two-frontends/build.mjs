// Bundle both frontend servers and both browser clients (with source
// maps — vibehard fails closed without them). Run: `node build.mjs`.
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const outdir = path.join(here, ".build");
const shared = { bundle: true, format: "esm", sourcemap: true, logLevel: "silent" };

for (const name of ["store", "admin"]) {
  await build({
    ...shared,
    entryPoints: [path.join(here, `src/${name}/server.ts`)],
    outfile: path.join(outdir, `${name}-server.mjs`),
    platform: "node",
  });
  await build({
    ...shared,
    entryPoints: [path.join(here, `src/${name}/client.ts`)],
    outfile: path.join(outdir, `${name}-client.mjs`),
    platform: "browser",
  });
}
