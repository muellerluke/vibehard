# next-express example

Next.js frontend plus a separate Express API, with Vibehard wired across
both processes. Declarations in `e2e/app.spec.ts` and `vibehard.lock.json`
are committed and verified.

```bash
# from the repo root, with the workspace installed and vibehard built:
npm run build -w next-express   # bundles the API, then next build

# from this directory:
node ../../packages/vibehard/dist/cli.js verify
node ../../packages/vibehard/dist/cli.js test --dry-run
```

Notes:

- `vibehard.config.json` declares the API as `servers: [{ name: "api", … }]`.
  Vibehard starts it before Next, passes its port to the frontend as
  `API_URL` (via `{port:api}`), exports `VIBEHARD_API_URL` to specs, and
  merges coverage from both processes into each test's observed set.
- The API is bundled by `build-api.mjs` (esbuild, CJS output with source
  maps — Express deps cannot run from an ESM bundle). Its `SIGTERM`
  handler exits through `process.exit` so coverage flushes.
- The order test declares only API symbols: frontend-only changes do not
  select it, API changes do (AT-20).
