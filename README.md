# vibehard

Exact e2e test selection via automatically recorded, machine-verified
symbol mapping. See [MANIFEST.md](MANIFEST.md) for the product spec.

You never declare what a test touches. `vibehard record` runs each test
under coverage and records every symbol it touched — functions it ran,
top-level constants and module code those functions reference, and
imported data files — with per-symbol source hashes in
`vibehard.lock.json` (committed to git). `vibehard test` diffs your
change against a base revision, maps changed lines to changed symbols,
and runs exactly the tests whose recorded touched set intersects them.

Status: Playwright, Puppeteer, and Cypress adapters.
`init`, `record`, `verify`, `test`, and `explain` work for all three
frameworks.

## Usage (Playwright)

```ts
import { test } from 'vibehard/playwright';

test('checkout applies a coupon', async ({ page }) => {
  /* existing test body, unchanged — nothing to declare */
});
```

The only per-test option is an escape hatch for genuinely unstable
tests, audited in the lockfile and counted under `verify --ci`:
`test('flaky live feed', { alwaysRun: 'live data' }, async …)`.
Such tests are never recorded and always run under `vibehard test`.

Get a `vibehard.config.json` from `vibehard init` (it detects Playwright,
Next.js App/Pages Router, and a separate Express backend, and prints the
remaining wiring steps). Then:

```bash
vibehard record   # map touched symbols from real runs into the lockfile
vibehard verify   # fail on any touched-set or lockfile drift
vibehard test     # run only the tests affected by your change
```

See `fixtures/tiny-app/` for a minimal fixture, and the Next.js examples
below for full-stack setups.

Once the lockfile is recorded, everyday runs select instead of verifying:

```bash
vibehard test                       # working tree vs baseBranch merge-base (or HEAD)
vibehard test --base main           # compare against an explicit ref
vibehard test --dry-run             # print the selected tests and why, run nothing
vibehard test --all                 # skip selection, run the full suite
vibehard explain 'src/lib/cart.ts#Cart.applyCoupon'  # which tests touched a symbol
vibehard explain 'checkout'         # recorded touched set for a test
```

Selection is exact or it does not happen: a config, package, or other
unmapped change, or a stale lockfile, runs the full suite (exit `3` under
`--dry-run`). Set `baseBranch` in `vibehard.config` to select against a
branch by default, and `ignore` globs for paths that may change freely.

Running plain `playwright test` is unaffected; the adapter only observes
when invoked through the vibehard CLI. Recording observes each test
twice and refuses to record a test whose touched set is not
reproducible. Verification is Chromium-only (Cypress client coverage
comes from Istanbul instrumentation instead).

## Usage (Puppeteer)

The host runner is Node's built-in test runner (`node --test`).
Register tests with `describeTest` and open pages with
`withVibehardPage` so browser coverage starts before navigation:

```js
import puppeteer from 'puppeteer';
import { describeTest, withVibehardPage } from 'vibehard/puppeteer';

describeTest('home page shows the cart total', async () => {
  const browser = await puppeteer.launch();
  const page = await withVibehardPage(browser);
  await page.goto(process.env['VIBEHARD_BASE_URL'] ?? 'http://127.0.0.1:4174');
  // ...assertions; closing the page/browser snapshots coverage first
});
```

Set `"framework": "puppeteer"` in `vibehard.config` and use the same
`record` / `verify` / `test` flow. Test leaf titles must be unique per
file (single tests are run via `--test-name-pattern`). See
`examples/plain-puppeteer` for a full non-Next setup.

## Usage (Cypress)

Cypress has no V8 range API, so client symbols come from Istanbul
instrumentation of the app build; server symbols still come from Node
V8 coverage. Wire the support file and node tasks once:

```js
// cypress/support/e2e.js
import { registerVibehardSupport } from 'vibehard/cypress';
registerVibehardSupport();

// cypress.config (setupNodeEvents)
import { registerVibehardTasks } from 'vibehard/cypress/node';

// specs need no vibehard code; recording maps what each test touches
it('home page shows the cart total', () => {
  cy.visit('/');
});
```

Set `"framework": "cypress"`, point `e2e.baseUrl` at
`process.env['VIBEHARD_BASE_URL']`, instrument the app build
(`window.__coverage__` must exist — see `examples/next-cypress` for
the Next.js recipe), and use the same `record` / `verify` / `test`
flow. A visited page without `__coverage__` fails verification
closed. Selection delegates at spec granularity with an exact
per-test title filter, so the run set matches `--dry-run`.

## Next.js and separate backends

Working examples with recorded lockfiles committed in `examples/`:

- `examples/next-fullstack` — App Router with a server component, a client
  component, a route handler, a server action, plus one Pages Router page
  and Pages API route in the same app.
- `examples/plain-puppeteer` — bundled frontend plus a Node HTTP
  backend, tested with Puppeteer on Node's test runner.
- `examples/next-cypress` — the Next.js full-stack shape tested with
  Cypress through the instrumented-coverage path.
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
- **Shared layout symbols are recorded like everything else.** Every
  page test's touched set includes its layouts automatically, so a
  layout change selects every page test under it — no bookkeeping.
- **Server actions count by their export name** in a top-level
  `'use server'` file. Actions inlined inside a component attribute to the
  enclosing component symbol.
- **Bundler inlining is handled**: callees inlined into a caller are
  recovered from source-map segments executed inside the caller. Note a
  pure helper called only with literal arguments may instead be
  constant-folded at build time; it then does not execute at runtime —
  but if an executed function statically references it (or a folded
  constant), it still enters the touched set as `referenced`, so
  changing it still selects the test.
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
- **Cost**: recording and verification restart every config server per
  test (record observes each test twice), so a record of N tests boots
  your app 2N times. That is the soundness tradeoff; `vibehard test`
  starts servers only once.

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
