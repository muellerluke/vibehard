# vibehard

Exact e2e test selection via automatically recorded, machine-verified
symbol mapping. See [MANIFEST.md](MANIFEST.md) for the product spec
and [SCALING.md](SCALING.md) for the large-repository performance
analysis and roadmap.

You never declare what a test touches. `vibehard record` runs each test
under coverage and records every symbol it touched — functions and class
members it ran (including computed, `#private`, namespace, and
factory-returned methods), the classes and top-level constants and module
code those functions reference, and imported data files — with per-symbol
source hashes in `vibehard.lock.json` (committed to git). Executed code
that no named symbol encloses counts at enclosing-class or whole-file
precision rather than being skipped. `vibehard test` diffs your
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
Selection in `test` and `explain` is diff-proportional by default:
cost scales with the change and the recorded touched sets, not the
whole repo — same exact result as the full-index algorithm, proven
by parity tests, with automatic fallback to full indexing on any
inconsistency (see [SCALING.md](SCALING.md) Phase 1).
`VIBEHARD_FAST_SELECT=0` forces the full-index reference path. The
parse cache lives under the git common dir and can be disabled with
`VIBEHARD_NO_CACHE=1`. A change to a test helper under
`testDir` selects exactly the specs that statically (transitively)
import it (reason `test-support-changed`; [SCALING.md](SCALING.md)
Phase 5); anything the static import graph cannot prove — a helper
no spec imports, a deleted or non-source support file, a computed
`import()`/`require()`, an unresolvable local import — still runs
the full suite.

Delegating a large selected set has no command-line or memory
ceiling: `vibehard test` splits the run into argv-budget chunks
(fully selected files are passed whole), proves the filter per
chunk, streams framework output live in text mode, and keeps only a
bounded tail under `--json` (see [SCALING.md](SCALING.md) Phase 4).
The 30-minute run timeout therefore applies per chunk, not per run.

Running plain `playwright test` is unaffected; the adapter only observes
when invoked through the vibehard CLI. Recording observes each test
twice and refuses to record a test whose touched set is not
reproducible. Verification is Chromium-only (Cypress client coverage
comes from Istanbul instrumentation instead).

For large suites, recording scales out without changing what is
recorded (same per-test observation, byte-identical lockfiles):

```bash
vibehard record --jobs 4                    # observe up to 4 tests at once on this machine
vibehard record --shard 1/3                 # one CI matrix job: writes vibehard-shard-1-of-3.json
vibehard record --shard 2/3 --shard-out s2.json
vibehard record --merge vibehard-shard-*.json  # validate all shards, write the lockfile once
vibehard record --incremental               # re-record only tests this change selects
```

`--jobs` is opt-in (default `1`) because your app must tolerate that
many parallel instances — ports are allocated for you, shared test
databases and other fixed resources are yours to isolate. `verify`
accepts `--jobs` and `--shard` too. `--incremental` refuses when
selection is unsafe (run a full record), and should be paired with a
scheduled full `vibehard verify` since it trusts the selection model
for tests it does not re-observe. See [SCALING.md](SCALING.md) Phase 3
for the merge contract and measurements.

In a monorepo, use one `vibehard.config` and lockfile per app, narrow
`include` to that app, and run vibehard per app in CI. Shared
workspace packages an app executes must lie inside the app's project
root (or be matched by `include`): source outside the indexed root
is invisible to recording and selection, so changes to it cannot be
mapped. Serving several frontends/backends from one root is the
`examples/two-frontends` shape below; indexing several source roots
into one lockfile is not supported.

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
- `examples/two-frontends` — two browser frontends (a store and an
  admin UI, each with its own server and bundle) in one project and one
  lockfile. There is only one `app` because Playwright/Cypress have a
  single base URL: the `app` entry becomes it, and every additional
  frontend is just another labeled `servers` entry — started fresh per
  test under coverage like any backend, and visited by absolute URL via
  its `VIBEHARD_<NAME>_URL`. A test that crosses both frontends records
  browser and server symbols from both into one touched set; a change
  in shared code selects tests of every frontend that touched it. The
  requirements are the same as for extra backends: Node processes
  Vibehard starts itself, sources under the one project root, and
  builds with source maps. Note every started server's boot code runs
  for every test, so an idle frontend contributes its server-startup
  symbols (not its pages) to other frontends' tests.

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
  starts servers only once. `--jobs`, `--shard`, and `--incremental`
  above divide the wall clock without changing that per-test cost.

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

## License

MIT — see [LICENSE](LICENSE).
