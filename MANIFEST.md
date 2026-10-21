# Vibehard Manifest

Build plan and product specification for the `vibehard` npm package.
This file is the contract. Implementation stages below are executed in order.
A stage is done only when its exit criteria and listed acceptance tests pass.

Status: Stages 0–6 complete; the declaration-based model of those stages was then replaced by automatically recorded touched sets (see "Touched set" below; there is no declaration API). Next: Stage 7 (hardening, performance, release).

## Goal

`vibehard` is an npm package that makes end-to-end (e2e) test selection exact.

Problem: e2e suites grow until running everything on every change is too slow.
Running only the tests affected by a change requires knowing which code each
test actually exercises. That mapping is normally guessed from file paths,
tags, or import graphs, and the guesses are wrong in both directions: affected
tests get skipped (escaped bugs) and unaffected tests get run (wasted CI time).

Vibehard replaces guessing with a recorded, machine-verified mapping.
The developer declares nothing:

1. `vibehard record` runs each test under coverage and maps every symbol
   it touched — functions/methods/components/route handlers it executed
   (client and server), top-level constants and other value bindings
   those functions statically reference, each touched file's module-level
   code, and imported data assets — into `vibehard.lock.json` with
   per-symbol source hashes. Each test is observed twice; a touched set
   that is not reproducible is reported unstable, never recorded.
2. `vibehard verify` re-runs each test under coverage and fails on any
   drift from the recorded touched set or lockfile hashes.
3. `vibehard test` diffs the working tree (or a commit range) against a base,
   maps changed lines to changed symbols, selects exactly the tests whose
   touched set intersects the changed set, and runs only those through the
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
- Multiple frontends and backends in one project tree: one frontend is
  the `app` entry (the framework base URL), every further frontend or
  backend is a labeled `servers` entry visited by absolute URL; all are
  started per test under coverage and merged into one lockfile, proven
  by `examples/two-frontends`.

## Success Criteria

The finished product is done when all of the following are true:

- A user can install `vibehard` into each sample project in this repo, run
  `vibehard record`, and get a green `vibehard verify` — without writing
  any symbol list.
- Changing app code so a test touches a new symbol, or stops touching a
  recorded one (including a top-level constant it reads via a function),
  makes `vibehard verify` fail with the exact symbol-level drift.
- Changing one app symbol (function, constant, module line, or imported
  asset) and running `vibehard test` runs exactly the tests that touched
  that symbol — verified against a ground-truth full run in the
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

Symbol kinds indexed:

- Executable: function declarations (including inside namespaces),
  arrow/function expressions assigned to a named binding, class
  methods/getters/setters/constructors (including `#private` members and
  statically named computed members such as `["checkout"]` or
  `[Symbol.iterator]`), React components (plain function symbols),
  object-literal methods, methods of objects returned directly by an
  IIFE/factory callee or attached by a top-level `a.b = …` assignment, and
  Next.js route/page exports by export name. Member IDs are always
  disambiguated from the member alone: statics live under `.static.`
  (`Cart.static.create` vs `Cart.create`) and accessors take a
  `:get`/`:set` suffix (`Cart.total:get`).
- `class`: the class declaration itself, e.g. `src/lib/cart.ts#Cart`. Its
  range spans the whole class, but its hash covers only the header
  (decorators, name, type parameters, `extends`/`implements`) and any
  static blocks, so header edits select tests that only ran members
  without member edits churning the class hash.
- `value`: every non-function binding in a declaration scope (top level or
  namespace) — `const`/`let`/`var` including each identifier bound by a
  destructuring pattern (`const { taxRate } = settings` is its own symbol),
  enums, non-function class fields, and individual object-literal
  properties (`settings.taxRate` alongside `settings`) — e.g.
  `src/lib/format.ts#CENTS_PER_DOLLAR`. Local constants inside a function
  need no symbol; they live inside that function's range and hash.
- `module`: one `file#<module>` per source file covering leftover top-level
  lines (imports, expression statements, side effects, type-only
  declarations). Its range spans the file so changed-line attribution
  always finds a smallest symbol; its hash covers only the leftover
  statement slices.
- `asset`: an imported non-code file (`.json`, `.css`, images, …) as
  `path#<file>`, hashed over the file's raw bytes.

Each symbol records its file, qualified name, kind, source range, and
`references`: the symbol IDs it statically references, resolved through the
TypeChecker (aliases and re-exports followed to the defining declaration).
References include ordinary and `#private` identifiers, namespace-qualified
names, string-literal element access (`cart["total"]`), the property a
destructured binding reads, and identifiers in class heritage clauses and
decorators (owned by the class symbol). Anonymous inline callbacks are
attributed to their nearest enclosing named symbol. Executed code with no
named enclosing symbol (dynamically computed members, top-level anonymous
handlers) is never dropped: it attributes to the nearest class symbol or,
failing that, the file's `module` symbol, trading precision for soundness.
Every non-blank line of an app file belongs to exactly one smallest
symbol — this is what makes changed-line attribution total.

Invariant: symbol IDs are stable across formatting-only edits and line moves
inside the same file. A rename or move to another file is a new symbol ID;
`vibehard verify` surfaces it as touched-set drift instead of guessing.

### Observed set, touched set, drift

- Observed set: the app symbols whose source ranges were executed while that
  single test ran, collected from browser and server coverage and remapped
  through source maps to original source ranges.
- Touched set: the recorded mapping for a test — its observed set plus
  (a) the `module` symbol of every file containing an observed symbol,
  (b) the `class` symbol of every class containing a touched symbol, and
  (c) the static-reference closure over value/module/asset symbols: every
  constant, module, or asset reachable by following `references` from the
  seeds through value initializers. Each entry is tagged `direct`,
  `referenced`, `module`, `class`, or `asset`. The closure never adds an executable
  symbol: an executable reached only by reference either ran (and is
  already a direct seed) or did not run. Merely being named — a route
  handler passed to `app.get(...)` at module scope — is not execution.
- Drift rule (the product's central invariant): re-observing a test must
  reproduce its recorded touched set exactly. Symbols touched now but not
  recorded (`added`) and recorded but not touched now (`removed`) are both
  `verify` failures. `record` observes each test twice and refuses to
  write a set that differs between the two runs (`unstable`).

Built-in exclusions, always applied before mapping: files under
`node_modules`, framework/runtime internals that have no app source file,
generated files without source maps, and test files themselves. Everything
else that executes from app source counts. Projects may add `ignore` globs.
There is no silent passthrough: executed code with no source map fails
closed as unmappable.

Why the closure is sound for selection: if a change adds a *new* reference
from a function to a constant, the function's own text changed, so the
function is itself a changed symbol and its tests run; the next `verify`
records the new edge as drift. Stored closures therefore cannot go stale
in a way that skips an affected test. The known precision cost is that a
constant read only on an untaken branch still selects the test — sound
over precise, and auditable via the `referenced` tag in `explain`.

### Lockfile

`vibehard.lock.json` (format version 2) at the project root is committed to
git. For each test it stores the recorded touched set with touch kinds, a
SHA-256 of each touched symbol's source (exact slice for executable/value
symbols, leftover-statement slices for `module`, raw bytes for `asset`),
plus the framework name/version, the config hash, and the
indexer/reference-graph version. `vibehard test` trusts the lockfile only
when every touched hash still matches the base revision's source, or every
hash matches the current source (a change whose author already re-ran
`record`); a lockfile matching neither endpoint, a graph-version mismatch,
or a missing lockfile falls back to a full run. The lockfile is the only
mapping artifact; there is nothing to keep in sync in test code. A
version-1 (declaration-based) lockfile is rejected with instructions to
delete it and re-run `record`.

## Approach

### Architecture

Five components behind small interfaces, all in the single `vibehard` package
with subpath exports per adapter (`vibehard/playwright`, `vibehard/puppeteer`,
`vibehard/cypress`). One package, not a published monorepo: adapters share the
core and version together until a real need to split appears.

1. Indexer. Parses the app with the TypeScript Compiler API (`Program` +
   `TypeChecker`), which handles TS, TSX, JS, and JSX with the project's own
   `tsconfig` module resolution. Emits the symbol table (all kinds above)
   and, from the TypeChecker, each symbol's resolved `references`. Chosen
   over syntax-only parsers because cross-file qualified names and
   re-export resolution need semantic information, and because target
   projects already have TypeScript installed (it is a peer-level tool dep,
   resolved from the user's project first). Evidence: TypeScript Compiler
   API wiki (see Sources).
2. Touch computation. Expands one test's observed set into its touched set
   (module rule + value/module/asset reference closure, above). There is
   no API for a test to state its set; adapters only carry coverage and
   the optional `alwaysRun: 'reason'` escape.
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
4. Verifier/recorder. Runs each test in isolation (one test per coverage
   window) and computes its touched set. `record` observes twice, rejects
   unstable sets, and writes `vibehard.lock.json` (never test files);
   `verify` diffs the recomputed set against the recorded one.
5. Selector and runner. Computes changed symbols from `git diff <base>`
   (working tree versus base, untracked files included): each changed line
   attributed to its smallest containing symbol at the matching revision,
   plus symbols in changed files that are new, deleted, or hash-changed
   (assets by content hash). Because every app line belongs to a symbol,
   app-source changes are never unmapped; config/package files, unreferenced
   assets, `.d.ts`, test-support files, and binary changes still force a
   full run. Selects tests whose touched set intersects changed symbols,
   plus tests whose spec file changed, `alwaysRun` tests, and unrecorded
   tests. Delegates execution to the
   project's framework with an explicit test filter: for Playwright,
   `file:line` positional filters (verified against `playwright test --list`
   before running) as documented in its CLI reference (see Sources); for
   Puppeteer, the host runner's name/file filter; for Cypress, its spec
   filter. Vibehard never reimplements a test runner.

Transitive impact rule: if symbol A changes, tests that touched A run. For
executables there is no call-graph expansion at selection time: a caller
that executed during recording also executed its callees, so they are
already direct seeds. For values, expansion happened at record time: a
constant read by an executed function is already in the stored touched set
as `referenced`. Direct intersection is therefore sound for both. Changes
that map to no symbol and are not ignored (config, env, unreferenced
public assets, package files) force a full run.

Next.js specifics: the dev/prod server is one Node process (plus workers), so
server coverage must be collected from every child process writing to the
coverage directory and merged. Where the app uses a Next.js
`instrumentation` file, Vibehard must not require replacing it; the Next
adapter documents either wrapping the user's `register` export or running
without it, since `register` runs once at server start and is the supported
hook for observability setup (see Sources). Separate-backend shape: each
server process gets its own coverage directory and a label in config; the
observer merges all labeled outputs into the test's observed set.

### Test-code surface

There is no declaration API. Specs import the adapter's test entry point
only so coverage can be collected; test bodies are unchanged:

```ts
import { test } from 'vibehard/playwright';

test('checkout applies a coupon', async ({ page }) => { /* ... */ });
```

Puppeteer: `describeTest(title, fn)` for the host runner (Node's built-in
test runner) plus `withVibehardPage(browser)` so coverage starts before
navigation. Cypress: `registerVibehardSupport()` in the support file and
`registerVibehardTasks(on)` in `setupNodeEvents`; specs contain no
vibehard calls at all.

The sole per-test option, explicit and audited in the lockfile:
`alwaysRun: 'reason'` (Cypress: an `alwaysRun('reason')` call in the test
body). Such a test is never recorded, always runs under `vibehard test`,
and is counted against the `--ci` budget (`alwaysRunBudget`, default 0).
It exists for genuinely unstable tests — the only remaining leniency.

### CLI

- `vibehard init` — detect framework and app shape, write `vibehard.config`,
  print the minimal wiring diff for the detected framework.
- `vibehard record [filter]` — run tests under observation (twice each),
  map touched symbols, update the lockfile. This is how suites adopt
  Vibehard, and how mappings are refreshed after intentional behavior changes.
- `vibehard verify [--ci]` — run tests under observation, fail on any
  touched-set drift or lockfile hash drift. `--ci` also fails on any
  `alwaysRun` count above `alwaysRunBudget` (default: 0).
- `vibehard test [--base <ref>] [--all] [--dry-run]` — select and run only
  affected tests. Default base: merge-base with the configured base branch,
  falling back to `HEAD`. `--all` skips selection and runs the full suite.
  `--dry-run` prints the selected set and the symbol-level reason for each
  selection without running.
- `vibehard explain <test|symbol>` — show the recorded touched set (with
  touch kinds) for a test, or which tests touched a symbol. Debugging
  surface; no run required.

Exit codes: `0` pass/selected-and-passed, `1` test failure passed through
from the framework, `2` verification drift or unstable record, `3` selection unsafe under
`--dry-run`. Without `--dry-run`, an unsafe selection performs a full run and
that run's result determines the exit code (`0` or `1`), with the unsafe
reason printed. Machine-readable `--json` on every command.

### Configuration

`vibehard.config.ts|js|json` at the project root:

- `framework`: `'playwright' | 'puppeteer' | 'cypress'`.
- `app`: `{ command, url, cwd? }` for the app server Vibehard starts (or
  `external: true` when the framework config already starts it, e.g.
  Playwright `webServer`). As shipped in Stage 5, `external` is accepted
  by `vibehard test` selection only: per-test server coverage cannot be
  attributed to a process Vibehard does not start and stop, so
  `verify`/`record` reject it with that reason. `{port}` in an entry's
  command/args/env/url is that entry's assigned port; `{port:<name>}`
  is another entry's.
- `servers`: optional extra labeled Node processes (separate backends
  or additional frontends — internally `app` is just the entry named
  `app`, whose only privileges are becoming the framework base URL via
  `VIBEHARD_BASE_URL` and the `external` escape hatch), started in
  order before `app`; each gets its own port and a
  `VIBEHARD_<NAME>_URL` env export for specs, and its coverage merges
  into every test's observed set. Additional frontends are navigated
  to by absolute URL, since Playwright/Cypress have a single base URL.
  All processes must be Node processes Vibehard starts itself, with
  their source under the one indexed project root.
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
  two-frontends/              two browser frontends in one project, Playwright
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

Deliverables: TypeScript-Compiler-API indexer producing the symbol table
(all symbol kinds, including value/module/asset) and per-symbol reference
graph for TS/TSX/JS/JSX; stable symbol IDs; enclosing-symbol lookup
for arbitrary ranges; index cache keyed by file content hash.
Gate: AT-02, AT-03, AT-04.

### Stage 2 — Coverage observation and symbol mapping

Deliverables: V8-range collection for a Node child process and for Chromium
via Playwright `Coverage`; source-map remapping of bundled/transpiled output
to original ranges; range→symbol mapping; merged client+server observed set
for one manually driven page load against `fixtures/tiny-app`.
Gate: AT-05, AT-06.

### Stage 3 — Recorder and verifier (Playwright)

Deliverables: `vibehard/playwright` test wrapper for coverage attribution
(no declaration to write; `alwaysRun` is the only option); per-test
isolated runs; touched-set computation; `vibehard record` (twice-observed,
unstable sets rejected) and `vibehard verify` (drift reporting);
`vibehard.lock.json` write/check with symbol source hashes.
Gate: AT-07 through AT-12.

### Stage 4 — Change selection and `vibehard test`

Deliverables: git-diff → changed-symbols mapping at base revision; test
selection by set intersection; delegation to Playwright with `file:line`
filters (checked against `--list`); unsafe-change detection with full-run
fallback; `--dry-run` with per-test selection reasons; `vibehard explain`.
Gate: AT-13 through AT-18. AT-17 is gated here for `fixtures/tiny-app`; its
`examples/next-fullstack` half closes at Stage 5, when that example lands.

### Stage 5 — Next.js full-stack and separate-backend support

Deliverables: multi-process server coverage merge; Next.js wiring guide and
`vibehard init` detection for Next (App + Pages); `examples/next-fullstack`
and `examples/next-express` fully wired with recorded lockfiles; server
components, route handlers, and server actions covered by fixture tests.
Gate: AT-19, AT-20, AT-21.

### Stage 6 — Puppeteer and Cypress adapters

Deliverables: `vibehard/puppeteer` (page-coverage wrapper, Node test runner
host support) with `examples/plain-puppeteer`; `vibehard/cypress`
(instrumented-coverage path) with `examples/next-cypress`; adapter conformance
suite so all adapters pass the same record/verify/select scenarios.
Gate: AT-22, AT-23, AT-24.

### Stage 7 — Hardening, performance, release

Performance work for this stage is analysed and sequenced in
[SCALING.md](SCALING.md) (diff-proportional selection, lockfile
interning, parallel/sharded recording, delegation limits); deliverables
below remain the stage definition.

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
  symbol table (IDs, kinds, ranges, references), including a class method,
  a class field, a top-level constant, per-file module symbols, an arrow
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

- AT-07: a test whose recomputed touched set equals its recorded set
  passes verify.
- AT-08: removing one touched symbol from the lockfile fails verify as
  drift, naming that symbol as `added` (touched now, not recorded).
- AT-09: adding one untouched symbol to the lockfile fails verify as
  drift, naming it as `removed` (recorded, not touched now).
- AT-10: changing app code so the test touches one new symbol fails verify
  as drift (`added`). This is the core promise; it must fail.
- AT-11: `vibehard record` writes the lockfile from real runs without
  modifying any spec file, and the result then passes verify; recording
  twice produces an identical lockfile.
- AT-12: tampering with `vibehard.lock.json` (or editing a touched symbol's
  source without re-verifying) is detected by hash mismatch.

Selection:

- AT-13: changing one symbol (function body, top-level constant, or module
  line) selects exactly the tests that touched it, with the correct touch
  kind in the reason (checked via `--dry-run` JSON).
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
- AT-18: deleting a symbol that tests touched selects those tests (they must
  fail or be re-recorded), not zero tests.

App shapes:

- AT-19: `examples/next-fullstack` — a server-component change, a
  client-component change, a route-handler change, and a server-action
  change each select exactly their touching tests.
- AT-20: `examples/next-express` — a change in the Express API selects the
  frontend e2e tests that touched the API symbol; frontend-only change does
  not select API-only tests.
- AT-21: Next.js running with its production build (not only `dev`) still
  maps coverage through source maps to the same symbol sets.
- AT-29: `examples/two-frontends` — one test crossing two browser
  frontends records browser and server symbols from both into one
  touched set; a store-only change selects the store and journey
  tests, an admin-only change the admin and journey tests, and a
  shared change every test.

Adapters:

- AT-22: Puppeteer adapter passes AT-07–AT-10 equivalents on
  `examples/plain-puppeteer`.
- AT-23: Cypress adapter passes AT-07–AT-10 equivalents on
  `examples/next-cypress` via the instrumented-coverage path.
- AT-24: the same touched sets verify identically under Playwright and
  Puppeteer for the shared fixture app (adapter conformance).

Hardening:

- AT-25: `record` observes each test twice; differing touched sets are
  reported as unstable with the differing symbols shown and nothing
  written for that test (never silently recorded).
- AT-26: parallel verification (≥4 workers) produces the same results as
  serial verification on the example suites.
- AT-27: `vibehard test` on `examples/next-fullstack` with a one-symbol
  change completes end-to-end (index + select + run) in under half the
  wall-clock of the full suite on CI hardware, measured and printed.
- AT-28: the packed npm tarball installs into a fresh copy of an example and
  passes `init` (already-wired detection), `verify`, and a one-symbol
  `test` selection without the monorepo present.
- AT-S01: parse-only extraction equals `indexProject` extraction (minus
  `references`) for every source file in the fixtures, examples, and
  `packages/vibehard/src` (`test/parse-parity.test.ts`).
- AT-S02: `--fast-select` selection equals full-index selection —
  selected IDs, reasons, changed symbols, unsafe reasons — over a
  mutation series on `fixtures/tiny-app` including asset, CRLF, and
  git-ignored-touched cases (`test/fast-select.test.ts`).
- AT-S03: with `--fast-select`, `vibehard test --dry-run` performs zero
  TypeScript `Program` constructions and zero worktree creations
  (asserted via Phase 0 timing phases and `git worktree list`).
- AT-S04: on the generated `large` fixture (3,000 source files, 3,000
  tests, K=150), `--fast-select` selection is measured against the
  Phase 0 baseline in SCALING.md; the proposed budgets (≤2 s
  cold-cache, ≤1 s warm, excluding discovery) are recorded there and
  not yet enforced in CI.

## Validation Plan

Commands are workspace scripts once Stage 0 lands; CI runs the same lines.

- Per stage: the stage's gated acceptance tests, e.g. Stage 1 gate is
  `npm test -w vibehard -- indexer` covering AT-02–AT-04, plus typecheck.
- Full gate (every merge): build, typecheck, lint, package tests, then the
  example suites (`verify` + mutation-based selection audits AT-17, AT-19,
  AT-20) in CI with browsers installed.
- Highest-risk validation step: AT-17 (recall audit) together with AT-05.
  If observed sets are wrong, everything downstream is unsound, so Stage 2
  is gated on exact ground-truth equality — not percentages.
- Manual checks that cannot be automated cheaply: README adoption walkthrough
  on a fresh machine (init → record → verify) before the Stage 7 release.

## Risks / Open Questions

Risks, with the designed mitigation:

- Large touched sets: shared providers/layouts make many tests touch the
  same symbols, weakening selection precision for those symbols. That is
  honest signal (a layout change really can affect every page), made
  auditable by `explain`; the remedy is smaller shared modules, not
  weakening the mapping silently.
- Source-map gaps (some bundlers/minifiers, server-only transforms) make
  ranges unmappable. Mitigation: fail closed (AT-06) and document required
  build settings per stack; never approximate a mapping.
- Non-deterministic execution (timers, A/B branches, lazy chunks) makes
  touched sets unstable. Mitigation: record-twice instability reporting
  (AT-25) and per-test isolation; unstable tests must be fixed or marked
  `alwaysRun` within the configured budget.
- Multi-process Next.js/worker coverage loss would under-report server
  symbols (false drift, and worse, missed selection). Mitigation:
  merge every process's coverage output; AT-19/AT-21 assert server symbols.
- Dynamic `import()` and code splitting: symbols in lazy chunks still map
  through source maps, but a chunk that never loads in verify and loads in
  production-like runs is an instability case under AT-25, not a selector
  bug. Documented, not hidden.
- Firefox/WebKit browser coverage: inspected coverage APIs are Chromium
  (CDP) based. v1 verification runs on Chromium only; other browser projects
  still run under `vibehard test` selection, but their touched sets are
  recorded and verified from the Chromium run. Stated in docs.

Open questions (none block Stage 0–2; each names its decision point):

- Puppeteer host runner: decided in Stage 6 — Node's built-in test
  runner only in v1 (`describeTest` + `withVibehardPage` in
  `vibehard/puppeteer`; single tests run via `--test-name-pattern`, so
  leaf titles must be unique per file). Third-party runners can be
  added behind the same driver interface later. Also decided in
  Stage 6: Cypress selection delegates per spec with an exact
  title filter (support-file skip), and the Next.js Cypress build uses
  webpack + `babel-plugin-istanbul` (`next build --webpack`, forced
  server source maps) because the Turbopack production build admits
  no Istanbul route — see `examples/next-cypress`.
- Mapping model: superseded. Stages 0–6 shipped author-written `uses`
  declarations with exact declared==observed verification; the model was
  then replaced by automatically recorded touched sets because (a) every
  declaration was in practice machine-generated by `record` anyway, and
  (b) functions were the only indexed symbols, so constants, imports, and
  module-level code that tracked functions read were untracked and every
  such change forced a full run. The recorded model keeps the soundness
  argument (drift detection + two-endpoint hash trust + fail-closed
  fallback) with no per-test authoring. Selection soundness for newly
  added references is argued under "Touched set" above.
- Should `vibehard test` also select tests for symbols whose *types* changed
  but whose bodies did not (type-only edits)? Decided in Stage 4: no — e2e
  observes runtime behavior, and the type checker owns type safety. Type-only
  files (`.d.ts`, `import type` targets with no runtime symbol) map to no
  symbol, so they are unmapped changes and force the AT-15 full-run fallback;
  projects that disagree can `ignore` them explicitly. (Imports, top-level
  code, and exported constants are no longer outside the symbol universe:
  they are `module`/`value` symbols and select precisely. Test support
  files remain unmapped by design.)

## Sources

Primary sources inspected for the decisions above:

- Playwright CLI reference (file and `--grep` filtering used by the runner):
  https://playwright.dev/docs/test-cli
- Git diff reference (working-tree versus commit comparison used by the selector):
  https://git-scm.com/docs/git-diff
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
