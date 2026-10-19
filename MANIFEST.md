# Vibehard Manifest

Build plan and product specification for the `vibehard` npm package.
This file is the contract. Implementation stages below are executed in order.
A stage is done only when its exit criteria and listed acceptance tests pass.

Status: Stage 0, Stage 1, Stage 2, and Stage 3 complete. Next: Stage 4 (change selection and `vibehard test`).

## Goal

`vibehard` is an npm package that makes end-to-end (e2e) test selection exact.

Problem: e2e suites grow until running everything on every change is too slow.
Running only the tests affected by a change requires knowing which code each
test actually exercises. That mapping is normally guessed from file paths,
tags, or import graphs, and the guesses are wrong in both directions: affected
tests get skipped (escaped bugs) and unaffected tests get run (wasted CI time).

Vibehard replaces guessing with a declared, machine-verified mapping:

1. Every e2e test declares the exact set of AST symbols it is allowed to
   exercise (functions, methods, components, route handlers) in the app under
   test, on both the client (browser) and server (Node.js) sides.
2. `vibehard verify` runs each test under coverage instrumentation and proves
   the declaration is exact: no declared symbol went unexercised, and no
   undeclared app symbol was exercised. Any mismatch fails with a diff.
3. `vibehard test` diffs the working tree (or a commit range) against a base,
   maps changed lines to changed symbols, selects exactly the tests whose
   declared set intersects the changed set, and runs only those through the
   project's existing e2e framework.

Target frameworks (adapters, in priority order): Playwright first, Puppeteer
second, Cypress third. Any further Node.js e2e framework is added through the
same adapter interface once these three prove it.

Target app shapes (all must work):

- Full-stack Next.js (App Router and Pages Router): client components, server
  components, route handlers, and server actions in one process tree.
- Next.js frontend plus a separate Node.js backend (Express, Nest, or plain
  Node HTTP): two processes, coverage collected from both and merged per test.
- Non-Next.js Node.js apps (bundled or plain-HTML frontend plus a Node
  backend) through the framework-agnostic core, proven by one fixture.

## Success Criteria

The finished product is done when all of the following are true:

- A user can install `vibehard` into each sample project in this repo, declare
  symbols for its tests, and get a green `vibehard verify`.
- Deliberately breaking a declaration (removing a used symbol, adding an unused
  one, or changing app code so a test exercises a new symbol) makes
  `vibehard verify` fail with the exact symbol-level diff.
- Changing one app symbol and running `vibehard test` runs exactly the tests
  that declare that symbol — verified against a ground-truth full run in the
  acceptance suite (selection recall is 100%: no affected test is ever
  skipped; precision is measured and reported, target 100% on fixtures).
- Safety falls back to a full run, never to a partial run, whenever selection
  cannot be proven safe (config change, lockfile/package change, unmapped
  changed file, missing or stale verification data).
- All acceptance tests in "Acceptance Tests" below pass in CI.

## Core Concepts and Invariants

### Symbol

A symbol is one addressable declaration in app source, identified by a stable
ID of the form `<relative-file>#<qualified-name>`, for example
`src/lib/cart.ts#Cart.addItem` or `src/app/checkout/page.tsx#CheckoutPage`.

Symbol kinds indexed in v1: function declarations, arrow/function expressions
assigned to a named binding, class declarations and their methods, React
components (functions returning JSX are still plain function symbols; no
special kind is needed), object-literal methods with a stable qualified name,
and Next.js route exports (`GET`, `POST`, default page/layout exports) by
their export name. Each symbol records its file, qualified name, kind, and
source range (start/end offsets and lines). Anonymous inline callbacks are
attributed to their nearest enclosing named symbol.

Invariant: symbol IDs are stable across formatting-only edits and line moves
inside the same file. A rename or move to another file is a new symbol ID;
`vibehard verify` surfaces it as a declaration diff instead of guessing.

### Declared set, observed set, exactness

- Declared set: the symbols a test's author wrote down (see Declaration API).
- Observed set: the app symbols whose source ranges were executed while that
  single test ran, collected from browser and server coverage and remapped
  through source maps to original source ranges.
- Exactness rule (the product's central invariant): after removing symbols
  matched by the project's `ignore` globs and the built-in exclusions below,
  declared set must equal observed set. Missing (declared, not observed) and
  extra (observed, not declared) are both failures.

Built-in exclusions, always applied before comparison: files under
`node_modules`, framework/runtime internals that have no app source file,
generated files without source maps, and test files themselves. Everything
else that executes from app source counts. Projects may add `ignore` globs,
and per-test `allowTransitive` patterns (below), but there is no silent
passthrough: an unmapped executed range in an app file is attributed to its
enclosing symbol and therefore shows up as `extra` until declared or ignored.

Known sharp edge, designed for explicitly: strict equality is brittle when a
test legitimately pulls in shared layout/provider symbols. That is intended.
Shared symbols must be declared (directly, or once in a shared declaration
group imported by many tests). The `vibehard record` command (below) exists
so authors generate the first declaration from a real run and then review it,
instead of hand-writing long lists.

### Lockfile

`vibehard.lock.json` at the project root is committed to git. For each test it
stores the verified declared set, a hash of each declared symbol's source
text, the framework adapter and version, and the config hash. `vibehard test`
trusts the lockfile only when every symbol hash still matches the base
revision's source; otherwise it re-verifies or falls back to a full run.
The lockfile is the artifact CI caches; the declaration in test code is the
artifact humans review. `vibehard verify` fails if the two disagree.

## Approach

### Architecture

Five components behind small interfaces, all in the single `vibehard` package
with subpath exports per adapter (`vibehard/playwright`, `vibehard/puppeteer`,
`vibehard/cypress`). One package, not a published monorepo: adapters share the
core and version together until a real need to split appears.

1. Indexer. Parses the app with the TypeScript Compiler API (`Program` +
   `TypeChecker`), which handles TS, TSX, JS, and JSX with the project's own
   `tsconfig` module resolution. Emits the symbol table and an import graph.
   Chosen over syntax-only parsers because cross-file qualified names and
   re-export resolution need semantic information, and because target projects
   already have TypeScript installed (it is a peer-level tool dep, resolved
   from the user's project first). Evidence: TypeScript Compiler API wiki
   (see Sources).
2. Declaration API. How a test states its symbol set (below).
3. Observer. Collects per-test executed ranges. Browser side: Chromium
   coverage through the framework's own coverage API — Playwright `Coverage`
   and Puppeteer `page.coverage` both expose start/stop JS coverage returning
   executed ranges per script (see Sources). Server side: Node.js built-in V8
   coverage output (`NODE_V8_COVERAGE` directory) collected per test window,
   with the app server started under Vibehard's control or attached via the
   inspector. Cypress has no equivalent native range API in the inspected
   docs; its documented path is Istanbul-style instrumentation of the app
   build, so the Cypress adapter consumes instrumented coverage instead of
   raw V8 ranges (see Sources). All paths converge on one internal form:
   executed ranges in original source files, after source-map remapping.
   Ranges are then mapped to symbols by containment in symbol ranges.
4. Verifier. Runs each test in isolation (one test per coverage window),
   builds the observed set, diffs it against the declared set, and writes or
   checks `vibehard.lock.json`. `vibehard record` is the same run with the
   diff applied to the declaration instead of failing.
5. Selector and runner. Computes changed symbols from `git diff <base>`:
   changed lines intersected with symbol ranges at the base revision, plus
   symbols in changed files that are new or deleted. Selects tests whose
   verified set intersects changed symbols. Delegates execution to the
   project's framework with an explicit test filter: for Playwright, a file
   list plus `--grep` title filter as documented in its CLI reference (see
   Sources); for Puppeteer, the host runner's name/file filter; for Cypress,
   its spec filter. Vibehard never reimplements a test runner.

Transitive impact rule: if symbol A changes, tests declaring A run. Tests
declaring only callers of A do not run on that basis alone, because a caller
that executed during verification also executed A — so A is already in that
test's observed (and therefore declared) set. Exact verification is what
makes direct intersection sound; no call-graph expansion is needed. The one
exception is non-code changes (config, env, public assets, package files):
any changed file that maps to no symbol and is not ignored forces a full run.

Next.js specifics: the dev/prod server is one Node process (plus workers), so
server coverage must be collected from every child process writing to the
coverage directory and merged. Where the app uses a Next.js
`instrumentation` file, Vibehard must not require replacing it; the Next
adapter documents either wrapping the user's `register` export or running
without it, since `register` runs once at server start and is the supported
hook for observability setup (see Sources). Separate-backend shape: each
server process gets its own coverage directory and a label in config; the
observer merges all labeled outputs into the test's observed set.

### Declaration API (how it should be used)

Primary form, per framework adapter, in test code next to the test:

Playwright (fixture/wrapper over `test`):

```ts
import { test } from 'vibehard/playwright';

test('checkout applies a coupon', {
  uses: [
    'src/app/checkout/page.tsx#CheckoutPage',
    'src/lib/cart.ts#Cart.applyCoupon',
    'src/app/api/coupons/route.ts#POST',
  ],
}, async ({ page }) => { /* existing test body, unchanged */ });
```

Puppeteer (no bundled runner): a `describeTest` helper for the host runner
plus a `withVibehardPage(browser, { uses })` wrapper that starts/stops
`page.coverage` around the test. Host runner choice is an open question
below; the adapter must work with at least Node's built-in test runner.

Cypress: a `vibehard.uses([...])` call registered in support code, keyed by
the current test title, with coverage read from the instrumented app.

Shared groups, to keep common layout/auth symbols declare-once:

```ts
// e2e/uses.ts
export const appShell = ['src/app/layout.tsx#RootLayout', /* ... */];
// in a test: uses: [...appShell, 'src/lib/cart.ts#Cart.applyCoupon']
```

Per-test escapes, explicit and audited in the lockfile: `allowTransitive:
['src/lib/analytics/**']` (observed matches permitted, still recorded) and
`skipVerify: 'reason'` (test always runs under `vibehard test`; counted and
printed in every report). No other implicit leniency exists.

### CLI

- `vibehard init` — detect framework and app shape, write `vibehard.config`,
  print the minimal wiring diff for the detected framework.
- `vibehard record [filter]` — run tests under observation, (re)write their
  declarations from observed sets, update the lockfile. This is how existing
  suites adopt Vibehard.
- `vibehard verify [--ci]` — run tests under observation, fail on any
  missing/extra symbol or lockfile drift. `--ci` also fails on any
  `skipVerify` count above the configured budget (default: no budget).
- `vibehard test [--base <ref>] [--all] [--dry-run]` — select and run only
  affected tests. Default base: merge-base with the configured base branch,
  falling back to `HEAD`. `--all` skips selection and runs the full suite.
  `--dry-run` prints the selected set and the symbol-level reason for each
  selection without running.
- `vibehard explain <test|symbol>` — show declared vs last observed set for a
  test, or which tests declare a symbol. Debugging surface; no run required.

Exit codes: `0` pass/selected-and-passed, `1` test failure passed through
from the framework, `2` verification mismatch, `3` selection unsafe under
`--dry-run`. Without `--dry-run`, an unsafe selection performs a full run and
that run's result determines the exit code (`0` or `1`), with the unsafe
reason printed. Machine-readable `--json` on every command.

### Configuration

`vibehard.config.ts|js|json` at the project root:

- `framework`: `'playwright' | 'puppeteer' | 'cypress'`.
- `app`: `{ command, url, cwd? }` for the app server Vibehard starts (or
  `external: true` when the framework config already starts it, e.g.
  Playwright `webServer`; server coverage then requires the documented env
  wiring that `vibehard init` prints).
- `servers`: optional extra labeled Node processes (separate backend shape).
- `include` / `ignore`: globs bounding app source that counts as symbols.
- `baseBranch`, `testDir`, `lockfile` path overrides.
- `fallback`: `'full'` (default, only v1 value) for unsafe selection.

### Repository layout (this repo)

npm workspaces. The publishable package lives in `packages/vibehard`;
fixtures and examples are private workspace packages that depend on it via
`workspace:*` so tests exercise the real installed artifact shape.

```text
packages/vibehard/            the npm package (CLI + core + adapters)
  src/indexer/  src/observer/  src/verifier/  src/selector/  src/cli/
  src/adapters/playwright|puppeteer|cypress/
  test/                       unit + integration tests for the package
examples/
  next-fullstack/             Next.js App Router, Playwright, Vibehard wired
  next-express/               Next.js frontend + Express API, Playwright
  plain-puppeteer/            plain frontend + Node API, Puppeteer adapter
  next-cypress/               Next.js + Cypress adapter (stage 6)
fixtures/                     tiny synthetic apps for fast package tests
  tiny-app/                   two pages, three symbols, known ground truth
```

## Steps

Stages run in order. Each stage lists deliverables and the acceptance tests
(from the next section) that gate it. Do not start a stage until the previous
stage's gate is green.

### Stage 0 — Repo and package skeleton

Deliverables (file-level manifest):

- Root: `package.json` (private, `workspaces: [packages/*, fixtures/*,
  examples/*]`), `tsconfig.base.json` (strict, `moduleResolution: bundler`,
  `jsx: react-jsx`), `eslint.config.js`, `.nvmrc` (Node 20), root scripts
  `build`/`typecheck`/`lint`/`test` delegating to workspaces, `README.md`
  (status + Stage 0 commands).
- `packages/vibehard/package.json`: `name: vibehard`, `version: 0.0.0`,
  `type: module`, `exports` for `.`, `./playwright`, `./puppeteer`,
  `./cypress` → `dist` (ESM+CJS+d.ts), `bin: { vibehard: ./dist/cli.js }`,
  `files: [dist]`, `engines: node >=20`. Build via `tsup` (`format:
  [esm, cjs]`, `dts: true`); tests via Vitest.
- `packages/vibehard/src/cli/index.ts`: `vibehard` bin stub — `--help`,
  `--version`, `--json`; subcommands `init`/`record`/`verify`/`test`/
  `explain` print "not implemented" and exit 3 (0/1/2 reserved per CLI
  exit-code table). Typed stubs in `src/{indexer,observer,verifier,selector}/`
  and `src/adapters/{playwright,puppeteer,cypress}/`; `test/cli.test.ts`
  automates AT-01.
- `fixtures/tiny-app/` (private workspace): `src/lib/cart.ts`
  (`Cart.addItem`), `src/lib/format.ts` (arrow binding),
  `src/app/checkout/page.tsx` (`CheckoutPage`),
  `src/app/api/coupons/route.ts` (`POST`), plus `expected-symbols.json`
  (IDs, kinds, ranges) as AT-02 ground truth.
- CI: `.github/workflows/ci.yml` (Node 20+22): `npm ci`, `build`,
  `typecheck`, `lint`, `test`, `vibehard --help`.

Gate: AT-01.

### Stage 1 — Symbol indexer

Deliverables: TypeScript-Compiler-API indexer producing the symbol table and
import graph for TS/TSX/JS/JSX; stable symbol IDs; enclosing-symbol lookup
for arbitrary ranges; index cache keyed by file content hash.
Gate: AT-02, AT-03, AT-04.

### Stage 2 — Coverage observation and symbol mapping

Deliverables: V8-range collection for a Node child process and for Chromium
via Playwright `Coverage`; source-map remapping of bundled/transpiled output
to original ranges; range→symbol mapping; merged client+server observed set
for one manually driven page load against `fixtures/tiny-app`.
Gate: AT-05, AT-06.

### Stage 3 — Declaration API and verifier (Playwright)

Deliverables: `vibehard/playwright` test wrapper with `uses`, shared groups,
`allowTransitive`, `skipVerify`; per-test isolated verification runs;
missing/extra diff reporting; `vibehard record` and `vibehard verify`;
`vibehard.lock.json` write/check with symbol source hashes.
Gate: AT-07 through AT-12.

### Stage 4 — Change selection and `vibehard test`

Deliverables: git-diff → changed-symbols mapping at base revision; test
selection by set intersection; delegation to Playwright with file+`--grep`
filter; unsafe-change detection with full-run fallback; `--dry-run` with
per-test selection reasons; `vibehard explain`.
Gate: AT-13 through AT-18.

### Stage 5 — Next.js full-stack and separate-backend support

Deliverables: multi-process server coverage merge; Next.js wiring guide and
`vibehard init` detection for Next (App + Pages); `examples/next-fullstack`
and `examples/next-express` fully wired with verified declarations; server
components, route handlers, and server actions covered by fixture tests.
Gate: AT-19, AT-20, AT-21.

### Stage 6 — Puppeteer and Cypress adapters

Deliverables: `vibehard/puppeteer` (page-coverage wrapper, Node test runner
host support) with `examples/plain-puppeteer`; `vibehard/cypress`
(instrumented-coverage path) with `examples/next-cypress`; adapter conformance
suite so all adapters pass the same declaration/verify/select scenarios.
Gate: AT-22, AT-23, AT-24.

### Stage 7 — Hardening, performance, release

Deliverables: index and verification caching with correctness-preserving
invalidation; parallel verification with per-test isolation guarantees;
flaky-observed-set detection (same test, different observed set across two
runs → reported, not silently recorded); README with adoption guide
(init → record → verify in CI → test), config reference, troubleshooting for
missing source maps and external servers; `npm pack` smoke test installing
the tarball into a fresh copy of `examples/next-fullstack`.
Gate: AT-25 through AT-28, plus full acceptance suite green.

## Acceptance Tests

The finished product must pass all of these. IDs are stable; stage gates
reference them. Tests live in `packages/vibehard/test` unless they name an
example. "Ground truth" means the fixture's hand-written expected sets.

Foundation:

- AT-01: clean checkout → install → build → `vibehard --help` exits 0; unit
  test runner executes.
- AT-02: indexer on `fixtures/tiny-app` returns exactly the ground-truth
  symbol table (IDs, kinds, ranges), including a class method, an arrow
  function binding, a JSX component, and a route export.
- AT-03: reformatting and moving code within files does not change any
  symbol ID; renaming a function changes exactly its own ID.
- AT-04: an executed range inside an anonymous callback is attributed to the
  nearest enclosing named symbol.

Observation:

- AT-05: loading one tiny-app page yields an observed set equal to ground
  truth for that page, client and server symbols correctly separated then
  merged, with bundling+source maps enabled.
- AT-06: with source maps disabled, observation reports the affected files
  as unmappable and verification fails closed (exit 2), never passes.

Verification (Playwright first; repeated per adapter in Stage 6):

- AT-07: a test whose declaration equals its observed set passes verify.
- AT-08: removing one used symbol from a declaration fails verify, naming
  that symbol as `extra` (observed, not declared).
- AT-09: adding one unused symbol fails verify, naming it as `missing`.
- AT-10: changing app code so the test exercises one new symbol (declaration
  untouched) fails verify as `extra`. This is the core promise; it must fail.
- AT-11: `vibehard record` on an undeclared test writes a declaration that
  then passes verify unchanged; recording twice is a no-op diff.
- AT-12: tampering with `vibehard.lock.json` (or editing a declared symbol's
  source without re-verifying) is detected by hash mismatch.

Selection:

- AT-13: changing one symbol's body selects exactly the tests declaring it
  (set equality against ground truth, checked via `--dry-run` JSON).
- AT-14: a whitespace-only change inside a symbol selects its tests (source
  hash changed) — selection is conservative, never clever about semantics.
- AT-15: changing a non-code tracked file (config/env/public asset) forces a
  full run and reports reason "unsafe: unmapped change" (exit `3` under
  `--dry-run`).
- AT-16: no changes against base → zero tests selected, exit 0, reason
  printed. (CI opting into "run smoke set anyway" is config, not default.)
- AT-17: recall audit — for every single-symbol mutation in
  `fixtures/tiny-app` and `examples/next-fullstack`, the selected set is a
  superset of the tests that fail or change observed set in a full run.
  Skipping an affected test anywhere fails this test.
- AT-18: deleting a symbol that tests declare selects those tests (they must
  fail or be re-recorded), not zero tests.

App shapes:

- AT-19: `examples/next-fullstack` — a server-component change, a
  client-component change, a route-handler change, and a server-action
  change each select exactly their declaring tests.
- AT-20: `examples/next-express` — a change in the Express API selects the
  frontend e2e tests that declare the API symbol; frontend-only change does
  not select API-only tests.
- AT-21: Next.js running with its production build (not only `dev`) still
  maps coverage through source maps to the same symbol sets.

Adapters:

- AT-22: Puppeteer adapter passes AT-07–AT-10 equivalents on
  `examples/plain-puppeteer`.
- AT-23: Cypress adapter passes AT-07–AT-10 equivalents on
  `examples/next-cypress` via the instrumented-coverage path.
- AT-24: the same declared sets verify identically under Playwright and
  Puppeteer for the shared fixture app (adapter conformance).

Hardening:

- AT-25: running verify twice on an unchanged tree produces identical
  observed sets, or the differing test is reported as unstable with both
  sets shown (never silently accepted).
- AT-26: parallel verification (≥4 workers) produces the same results as
  serial verification on the example suites.
- AT-27: `vibehard test` on `examples/next-fullstack` with a one-symbol
  change completes end-to-end (index + select + run) in under half the
  wall-clock of the full suite on CI hardware, measured and printed.
- AT-28: the packed npm tarball installs into a fresh copy of an example and
  passes `init` (already-wired detection), `verify`, and a one-symbol
  `test` selection without the monorepo present.

## Validation Plan

Commands are workspace scripts once Stage 0 lands; CI runs the same lines.

- Per stage: the stage's gated acceptance tests, e.g. Stage 1 gate is
  `npm test -w vibehard -- indexer` covering AT-02–AT-04, plus typecheck.
- Full gate (every merge): build, typecheck, lint, package tests, then the
  example suites (`verify` + mutation-based selection audits AT-17, AT-19,
  AT-20) in CI with browsers installed.
- Highest-risk validation step: AT-17 (recall audit) together with AT-05.
  If observed sets are wrong, everything downstream is unsound, so Stage 2
  is gated on exact ground-truth equality — not percentages — before any
  declaration work begins.
- Manual checks that cannot be automated cheaply: README adoption walkthrough
  on a fresh machine (init → record → verify) before the Stage 7 release.

## Risks / Open Questions

Risks, with the designed mitigation:

- Exact-equality friction: shared providers/layouts inflate declarations.
  Mitigation is `record` + shared groups + `allowTransitive`; if real suites
  still drown, that is product feedback to answer with better grouping, not
  by weakening equality silently.
- Source-map gaps (some bundlers/minifiers, server-only transforms) make
  ranges unmappable. Mitigation: fail closed (AT-06) and document required
  build settings per stack; never approximate a mapping.
- Non-deterministic execution (timers, A/B branches, lazy chunks) makes
  observed sets unstable. Mitigation: AT-25 instability reporting and
  per-test isolation; unstable tests must be fixed or `skipVerify`-budgeted.
- Multi-process Next.js/worker coverage loss would under-report server
  symbols (false `missing`, and worse, missed selection). Mitigation:
  merge every process's coverage output; AT-19/AT-21 assert server symbols.
- Dynamic `import()` and code splitting: symbols in lazy chunks still map
  through source maps, but a chunk that never loads in verify and loads in
  production-like runs is an instability case under AT-25, not a selector
  bug. Documented, not hidden.
- Firefox/WebKit browser coverage: inspected coverage APIs are Chromium
  (CDP) based. v1 verification runs on Chromium only; other browser projects
  still run under `vibehard test` selection, but their declarations are
  verified from the Chromium run. Stated in docs, revisited post-v1.

Open questions (none block Stage 0–2; each names its decision point):

- Puppeteer host runner: support Node's built-in test runner only in v1, or
  also a third-party runner? Decide at Stage 6 start from the adapter
  interface's needs; default assumption is Node's built-in runner first.
- Declaration syntax: wrapper options object (chosen above for Playwright)
  vs annotation comments. Assumption: options object is primary because it
  is type-checked and refactor-visible; comments only if a framework cannot
  carry options. Revisit only with Stage 3 user feedback from the examples.
- Should `vibehard test` also select tests for symbols whose *types* changed
  but whose bodies did not (type-only edits)? Assumption: no — e2e observes
  runtime behavior, and the type checker owns type safety. Type-only files
  (`.d.ts`, `import type` targets with no runtime symbol) map to no symbol;
  whether they force the AT-15 full-run fallback is decided in Stage 4,
  defaulting to the safe full run until proven otherwise.

## Sources

Primary sources inspected for the decisions above:

- Playwright CLI reference (file and `--grep` filtering used by the runner):
  https://playwright.dev/docs/test-cli
- Playwright Coverage API (browser-side executed ranges):
  https://playwright.dev/docs/api/class-coverage
- Puppeteer Coverage API (`page.coverage` JS coverage, Istanbul note):
  https://pptr.dev/api/puppeteer.coverage
- TypeScript Compiler API (`Program`, `TypeChecker`, symbols):
  https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API
- Node.js Command-line API (built-in V8 coverage output, test runner):
  https://nodejs.org/api/cli.html
- Next.js `instrumentation` file convention (`register` hook):
  https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation
- Cypress code coverage docs (instrumentation-based coverage path):
  https://docs.cypress.io/app/tooling/code-coverage
