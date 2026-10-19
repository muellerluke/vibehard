# vibehard

Exact e2e test selection via declared, machine-verified symbol mapping.
See [MANIFEST.md](MANIFEST.md) for the product spec and staged build plan.

Status: Stage 5 — Next.js (App + Pages Router) and separate-backend
support. `init`, `record`, `verify`, `test`, and `explain` all work.

## Usage (Playwright)

```ts
import { test } from 'vibehard/playwright';

test('checkout applies a coupon', {
  uses: [
    'src/app/checkout/page.tsx#CheckoutPage',
    'src/lib/cart.ts#Cart.applyCoupon',
  ],
}, async ({ page }) => { /* existing test body, unchanged */ });
```

Get a `vibehard.config.json` from `vibehard init` (it detects Playwright,
Next.js App/Pages Router, and a separate Express backend, and prints the
remaining wiring steps). Then:

```bash
vibehard record   # generate/repair declarations from real runs
vibehard verify   # fail on any missing/extra symbol or lockfile drift
vibehard test     # run only the tests affected by your change
```

See `fixtures/tiny-app/` for a minimal fixture, and the Next.js examples
below for full-stack setups.

Once declarations verify, everyday runs select instead of verifying:

```bash
vibehard test                       # working tree vs baseBranch merge-base (or HEAD)
vibehard test --base main           # compare against an explicit ref
vibehard test --dry-run             # print the selected tests and why, run nothing
vibehard test --all                 # skip selection, run the full suite
vibehard explain 'src/lib/cart.ts#Cart.applyCoupon'  # which tests declare a symbol
vibehard explain 'checkout'         # declared vs last observed set for a test
```

Selection is exact or it does not happen: a config, package, or other
unmapped change, or a stale lockfile, runs the full suite (exit `3` under
`--dry-run`). Set `baseBranch` in `vibehard.config` to select against a
branch by default, and `ignore` globs for paths that may change freely.

Running plain `playwright test` is unaffected; the adapter only observes
when invoked through the vibehard CLI. Verification is Chromium-only in v1.

## Next.js and separate backends

Working examples with verified declarations committed in `examples/`:

- `examples/next-fullstack` — App Router with a server component, a client
  component, a route handler, a server action, plus one Pages Router page
  and Pages API route in the same app.
- `examples/next-express` — the same Next.js frontend shape plus a
  separate Express API as a labeled `servers: [{ name: "api", … }]` entry.
  Vibehard starts extra servers before the app, gives each its own port
  (`{port}` is its own, `{port:api}` is another server's), exports
  `VIBEHARD_<NAME>_URL` to specs, and merges coverage from every process —
  including workers the servers spawn themselves.

Things that matter in a Next.js project:

- **Verify against the production build.** Run `next build`, then let
  Vibehard start the app with `next start` (`app.command`/`app.args`).
  Dev-server output is not verifiable and fails closed.
- **Turn on browser source maps**: `productionBrowserSourceMaps: true` in
  `next.config`. Server chunk maps are emitted by default. Unmapped
  executed code fails verification (exit 2) instead of passing silently.
- **Prerendered routes are invisible to tests.** Static (○) routes
  execute at build time, not while a test runs. Mark routes under test
  dynamic: `export const dynamic = 'force-dynamic'` (App Router) or
  `getServerSideProps` (Pages Router).
- **Shared layout symbols are real declarations.** Every page test
  observes its layouts; declare them once in a shared group (see
  `e2e/uses.ts` in the examples) and spread it into tests.
- **Server actions count by their export name** in a top-level
  `'use server'` file. Actions inlined inside a component attribute to the
  enclosing component symbol.
- **Bundler inlining is handled**: callees inlined into a caller are
  recovered from source-map segments executed inside the caller. Note a
  pure helper called only with literal arguments may instead be
  constant-folded at build time; it then genuinely does not execute at
  runtime, so it is correctly absent from observed sets.
- **No `instrumentation.ts` changes are needed.** Vibehard starts the
  server itself and never touches your `register()` export.
- **Ports and hoisting**: in an npm-workspaces repo, `next` may be
  hoisted to the workspace root; point `app.args` at the real Next bin or
  use a resolver script (see `start-server.mjs` in the examples) so
  `node` stays the direct parent process — coverage flushes when
  Vibehard stops the server.
- **`app.external: true`** (Playwright `webServer` starts the app) is
  accepted by `vibehard test` selection, but `verify`/`record` reject it:
  per-test coverage windows need Vibehard to start a fresh app per test.
- **Cost**: verification restarts every config server per test, so a
  verify of N tests boots your app N times. That is the soundness
  tradeoff in this version; `vibehard test` starts servers only once.

## Development

```bash
npm install
npx playwright install chromium
npm run build
npx vibehard --help
npm test
npm run typecheck
npm run lint
```
