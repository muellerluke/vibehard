# plain-puppeteer example

Plain bundled frontend plus a Node HTTP backend, tested with Puppeteer
through Node's built-in test runner and Vibehard wired. Declarations
are produced by `vibehard record` (run it after building) and kept in
`e2e/app.test.mjs` + `vibehard.lock.json`.

```bash
# from the repo root, with the workspace installed and vibehard built:
npm run build -w plain-puppeteer

# from this directory:
node ../../packages/vibehard/dist/cli.js verify
node ../../packages/vibehard/dist/cli.js test --dry-run
```

Notes:

- Specs use `describeTest` + `withVibehardPage` from
  `vibehard/puppeteer`; plain `node --test e2e/` runs are unaffected
  (start `.build/server.mjs` yourself first, on `PORT=4174`).
- Server and client are bundled by `build.mjs` (esbuild, ESM with
  source maps — unmapped executed code fails verification closed).
- The server's `SIGTERM` handler exits through `process.exit` so V8
  coverage flushes when Vibehard stops it.
- Test leaf titles must be unique per file: single tests are selected
  with `node --test --test-name-pattern`.
