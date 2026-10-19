// Bundle the Express API (single file + source map) for vibehard's
// `servers[api]` entry. Run from this directory: `node build-api.mjs`.
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [path.join(here, "api/src/server.ts")],
  outfile: path.join(here, ".build/api.cjs"),
  bundle: true,
  // Express and its deps are CommonJS with dynamic requires of Node
  // builtins; an ESM bundle cannot run them. CJS output can.
  format: "cjs",
  platform: "node",
  sourcemap: true,
  logLevel: "silent",
});
