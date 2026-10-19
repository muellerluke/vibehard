# next-fullstack example

Next.js (App Router primary, one Pages Router page + API route) with
Vibehard wired. Declarations in `e2e/app.spec.ts` and `vibehard.lock.json`
are committed and verified.

```bash
# from the repo root, with the workspace installed and vibehard built:
npm run build -w next-fullstack

# from this directory:
node ../../packages/vibehard/dist/cli.js verify
node ../../packages/vibehard/dist/cli.js test --dry-run
```

Notes:

- `next.config.mjs` sets `productionBrowserSourceMaps: true` (required —
  browser coverage is remapped through source maps).
- Tested routes render per request (`force-dynamic` /
  `getServerSideProps`); prerendered routes execute at build time and
  cannot be observed by a test.
- `vibehard.config.json` starts the production server through
  `start-server.mjs`, which resolves the Next bin through the module
  system (works with npm-workspaces hoisting and standalone installs).
