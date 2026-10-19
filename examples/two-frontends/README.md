# two-frontends example

Two browser frontends — a store and an admin UI, each with its own Node
server, browser bundle, and source tree under one project root — recorded
into one lockfile. This proves multiple frontends need no special
support: one frontend is the config `app` (it becomes Playwright's
`baseURL`, exported as `VIBEHARD_BASE_URL`), and every additional
frontend is a labeled `servers` entry, started fresh per test under
coverage exactly like a backend and visited by absolute URL
(`VIBEHARD_ADMIN_URL` here). Coverage from the browser, the store
server, and the admin server merges into each test's touched set.

```bash
# from the repo root, with the workspace installed and vibehard built:
npm run build -w two-frontends

# from this directory:
node ../../packages/vibehard/dist/cli.js verify
node ../../packages/vibehard/dist/cli.js test --dry-run
```

Notes:

- `src/shared/pricing.ts` is used by both frontends: editing it selects
  all three tests. Editing `src/store/catalog.ts` selects the store and
  journey tests only; editing `src/admin/stats.ts` selects the admin
  and journey tests only.
- Each frontend serves its client bundle under a distinct URL
  (`/store-client.js`, `/admin-client.js`) so `generatedScripts` maps
  each browser script to its own bundle unambiguously.
- The one-`app` shape mirrors Playwright/Cypress having a single base
  URL: relative `page.goto("/")` resolves against the store; other
  frontends are reached by absolute URL from their `VIBEHARD_<NAME>_URL`.
- Servers exit through `process.exit` on `SIGTERM` so V8 coverage
  flushes when Vibehard stops them.
- Both servers start for every test, so each single-frontend test also
  records the other server's startup symbols (its `<module>` and boot
  values — that code genuinely ran), but none of its page, client, or
  request-handling symbols.
