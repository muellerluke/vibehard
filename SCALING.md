# Scaling Vibehard to Large Repositories

Status: **Phases 0–5 implemented** (Phase 1 diff-proportional
selection is the default; the full-index path remains as fallback
and parity oracle; Phase 2 lockfile v3 auto-migrates v2 files on the
next write; Phase 3a–c ship `--jobs` lanes, `--shard`/`--merge`
artifacts, and `record --incremental`; Phase 4 ships chunked
delegation, streaming/bounded run output, and file-based Playwright
discovery; Phase 5 ships test-support mapping and monorepo scoping
docs; see the per-phase "results" sections below, including a
before/after benchmark against the pre-scaling baseline under
"Phase 3 results").
Only the optional finer config classification (Phase 5's third
bullet) and the 3d server-reuse spike remain proposals. This
document collects the
performance analysis and the phased plan for making `vibehard` usable in
repositories with thousands of e2e tests and thousands of source files.
It is a companion to [MANIFEST.md](MANIFEST.md), whose Stage 7
("Hardening, performance, release") this work belongs to. Nothing here
changes the product contract in the manifest; where this document and
the manifest disagree, the manifest wins until it is amended.

This document answers three questions, in order:

1. Would rewriting the package in Rust (still published on npm) make it
   faster?
2. Can the current implementation handle thousands of e2e tests and
   still determine quickly, from the changed files, which tests to run?
3. What should be changed so that it can?

## Summary

The single most important finding: **test count is not the scaling
bottleneck for selection — whole-repo indexing is, and sequential
recording is a larger bottleneck still.**

- The selection arithmetic (changed symbols ∩ each test's touched set)
  is a linear scan and stays sub-second at millions of touched edges.
- `vibehard test` pays two full TypeScript `Program` constructions
  (working tree and a base worktree checkout) and hashes every symbol
  on both sides, regardless of how small the diff is.
- `vibehard record` observes tests strictly sequentially, starting the
  app servers and a fresh framework process per test, twice per test.
  At thousands of tests this is measured in hours.
- The v2 lockfile repeats every symbol ID and its 64-character hash
  once per test that touched it, so lockfile size grows with total
  touched edges and reaches hundreds of megabytes at plausible scale.

The fix is therefore not to make the whole-repo scans faster (in Rust
or otherwise). It is to **remove whole-repo work from the everyday
path**: keep the expensive, complete proof in `record`, and make
`test` cost proportional to the diff. A Rust rewrite is feasible on
npm and is assessed below, but it is the wrong first move: the one
component where Rust would help most is the one whose semantics are
hardest to port faithfully, and the algorithmic fixes dominate any
constant-factor win.

## Non-negotiable invariants

Every optimisation in this plan must preserve the manifest's safety
contract. A performance change that weakens any of these is rejected,
however fast it is:

- **Exact or nothing.** Selection runs exactly the affected tests, or
  it does not happen. Anything that cannot be mapped to symbols (or to
  a trusted lockfile) is an unsafe reason and falls back to a full
  run — never to a partial run.
- **Fail closed.** Missing source maps, unmappable executed code,
  unreadable base source, ambiguous discovery, and unsupported shapes
  are errors or full-run fallbacks, never approximations.
- **Recall is 100%.** No affected test may ever be skipped. Precision
  may be traded for safety (selecting extra tests is allowed when the
  plan says so explicitly); recall may not.
- **Recorded, not declared.** No API is added for a test or a user to
  state what a test touches. All mappings stay machine-generated.
- **Reproducibility gate stays.** `record` observes each test twice
  and refuses to record a test whose touched set is not reproducible.

## Scaling variables

Costs below are stated in terms of these quantities. Confusing them is
what makes "thousands of tests" a misleading yardstick on its own:

| Symbol | Meaning | Driven by |
|---|---|---|
| F | Indexed source files | App size, `tsconfig` include |
| S | Indexed symbols | App size, declaration density |
| T | Discovered e2e tests | Suite size |
| K | Average touched symbols per test | App shell/shared code, closure rules |
| E = T·K | Total touched edges in the lockfile | Suite size × shared code |
| C | Changed files in the diff | One change/PR |
| L | Changed lines (hunks) | One change/PR |

A repository with thousands of tests usually also has large F and
large K (a shared layout, auth, and data layer that most tests
execute). All three must be considered together.

## How the current implementation spends time

### `vibehard test` / `selectTests`

The selection path in
[`packages/vibehard/src/selector/select.ts`](packages/vibehard/src/selector/select.ts)
(`selectTests`) performs, on every invocation:

1. `git` subprocesses: resolve base (`merge-base` or `HEAD`), list
   changed files (`diff --name-status` plus untracked `ls-files`),
   and fetch a zero-context patch. Cost ~O(C).
2. Test discovery through the framework driver. For Playwright this
   spawns `playwright test --list --reporter=json`
   (`packages/vibehard/src/verifier/playwright-runner.ts`), which
   loads the config and every spec file. This is the framework's cost,
   roughly O(spec files), plus fixed startup.
3. A full `indexProject(rootDir)` of the working tree
   (`packages/vibehard/src/indexer/index.ts`): a TypeScript
   `createProgram` over every file the `tsconfig` includes, symbol
   extraction per file, and `computeReferences` driven by
   `program.getTypeChecker()`. Cost ~O(F) with a large constant
   (lib files, module resolution, checker construction).
4. A temporary `git worktree` checkout of the base revision
   (`packages/vibehard/src/selector/git.ts`, `createBaseWorktree`),
   followed by a second full `indexProject` of that checkout.
5. Hashing of **every** indexed symbol on both sides via
   `hashSymbolSources`
   (`packages/vibehard/src/verifier/lockfile.ts`): every indexed file
   is read and every symbol's source slice is SHA-256-hashed.
   Cost ~O(total indexed source bytes).
6. Changed-symbol computation for changed app/asset files only
   (`packages/vibehard/src/selector/changed.ts`,
   `computeChangedSymbolsForFile`): each changed line is attributed
   to its smallest containing symbol by a linear scan of that file's
   symbols. Cost ~O(L · symbols per changed file).
7. Lockfile load (`JSON.parse` of the whole file) and the trust check
   (`lockfileTrustReasons`), which compares every touched symbol hash
   of every discovered test against both base and head hashes.
   Cost ~O(E).
8. The selection loop itself: for each discovered test, sort its
   touched keys and test membership in the changed-symbol set.
   Cost ~O(E log K).

After selection, `testProject`
(`packages/vibehard/src/selector/run.ts`) additionally runs the
driver's `proveFilter` (for Playwright, a second `--list` with one
`file:line` positional per selected test) and delegates the run with
the same positionals as process arguments.

Two structural facts stand out:

- `indexProject` accepts an `IndexCache`, but **no CLI path passes
  one**: the four call sites in `selector/select.ts`,
  `selector/run.ts`, and `verifier/run.ts` all index cold. And even
  with a cache, `createProgram` runs before the cache is consulted and
  `computeReferences` runs unconditionally, so the dominant costs are
  not cacheable as the code stands.
- Everything in steps 3–5 is independent of the diff. A one-line
  change pays the same indexing bill as a thousand-file change.

### `vibehard record` / `verify`

`verifyProject`
(`packages/vibehard/src/verifier/run.ts`) indexes once (full program,
references needed for the touched-set closure), discovers tests, then
loops over the selected tests **sequentially**. For each test,
`observeOnce`:

1. Starts all configured servers fresh (`startServers` in
   `packages/vibehard/src/verifier/servers.ts`), each as a coverage
   child with its own `NODE_V8_COVERAGE` directory.
2. Spawns a fresh framework process for exactly one test
   (`runSingleTest`; Playwright runs with `--workers=1 --retries=0`).
3. Stops the servers to flush and collect their V8 coverage, reads
   the adapter's per-test artifact, remaps source maps, and maps
   ranges to symbols.

In `record` mode this whole cycle runs **twice** per test and the two
touched sets must be identical. Server restart per test is not
carelessness: Node's built-in V8 coverage is cumulative for the life
of the process and only flushes at exit (see `spawnWithCoverage` in
`packages/vibehard/src/observer/node-child.ts`), so one server
lifetime == one attribution window today.

Per-test cost is therefore
`server startup + framework startup + test duration`, times two,
times T, with no parallelism. At an assumed 8 s per observation cycle,
recording 3,000 tests takes roughly 13 hours of wall clock.

### The lockfile

Format v2 (`packages/vibehard/src/verifier/lockfile.ts`) stores, per
test, a `touched` map and a `symbolHashes` map, both keyed by full
symbol ID. A symbol touched by 2,000 tests has its ID and its
64-character hex hash written out 2,000 times. Serialization is
pretty-printed (`JSON.stringify(…, null, 2)`). Size is ~O(E · ~150
bytes). The file is committed to git, so beyond parse time this costs
reviewability, merge conflicts, and repository weight.

### Delegation and output handling

- Playwright selection is delegated with one `file:line` argument per
  selected test (`runMany`), and proven with a second `--list` using
  the same arguments. Cypress joins all selected specs into one
  `--spec a,b,c` argument; Puppeteer groups titles into a per-file
  `--test-name-pattern` run per file.
- `spawnCapture`
  (`packages/vibehard/src/verifier/servers.ts`) buffers a child's
  entire stdout/stderr into strings by repeated concatenation. Test
  discovery output and full framework runs are both held whole in
  memory.
- Puppeteer `runMany` runs file groups sequentially.

## Evidence

All measurements below were taken on this repository on 2026-10-20
(macOS, Node 20+). They are a baseline for the plan, not a benchmark
suite; Phase 0 replaces them with repeatable fixtures.

### Real indexer and selection timings

| Measurement | Size | Time |
|---|---|---|
| `indexProject` on `fixtures/tiny-app` | 4 files, 11 symbols | 0.52 s |
| `indexProject` on `examples/next-fullstack` | 11 files, 24 symbols | 0.81 s |
| `indexProject` on `packages/vibehard` | 56 files, 519 symbols | 1.26 s |
| `vibehard test --dry-run` in `fixtures/tiny-app` | 2 tests, 0 changed files | 1.98 s |

The 4-file project already costs half a second: this is fixed
TypeScript program/checker startup, paid twice per selection (head
and base). Extrapolating to several thousand indexed files puts
selection alone in the tens of seconds, possibly minutes. That
extrapolation is an inference, not a measurement — nothing in this
repo exercises more than 4 tests today, which is itself a finding:
**the current test suite provides no evidence about behaviour at
scale.**

### Synthetic selection-core timings

A throwaway script reproducing the shapes of the trust scan and the
selection loop (hash-map comparisons and sorted-key membership tests
over all edges), plus v2-format serialization:

| Tests (T) | Touched/test (K) | Edges (E) | Lockfile size | JSON parse | Trust scan | Selection scan |
|---|---|---|---|---|---|---|
| 1,000 | 50 | 50,000 | 7.3 MB | 35 ms | 9 ms | 7 ms |
| 3,000 | 150 | 450,000 | 65 MB | 262 ms | 57 ms | 78 ms |
| 5,000 | 200 | 1,000,000 | 144 MB | 583 ms | 132 ms | 193 ms |
| 10,000 | 300 | 3,000,000 | 432 MB | 1,819 ms | 386 ms | 584 ms |

Conclusions: the arithmetic is not the problem even at 10,000 tests;
the on-disk format is. K in the shipped examples averages only 5–20
because the apps are tiny. Real suites execute an app shell, layout,
providers, and shared modules per test, and `computeTouchedSet`
(`packages/vibehard/src/verifier/touched.ts`) additionally adds a
module symbol per contributing file plus a static reference closure,
so K in the 50–300 range is the planning assumption.

## Findings

- **F1 — Selection is O(F), not O(C).** Two full programs plus
  whole-repo hashing on every `vibehard test`, even for a one-line
  diff. This is the everyday latency problem.
- **F2 — The index cache is effectively unused.** No CLI path passes
  a cache, and the expensive parts (program construction, checker)
  run before/outside it.
- **F3 — Recording is O(T) sequential process spawns.** Fresh servers
  and a fresh framework process per test, twice per test, no lanes,
  no sharding contract. This is the adoption problem: a large suite
  cannot be recorded in a reasonable time or re-recorded routinely.
- **F4 — Lockfile size is O(E) with a large constant.** Per-test
  duplication of symbol IDs and hashes, pretty-printed. Git-hostile
  well before it is CPU-hostile.
- **F5 — Delegation has argv and memory ceilings.** One process
  argument per selected test (Windows' ~32k-character command line is
  the tightest limit), a second discovery pass to prove the filter,
  and whole-output string buffering.
- **F6 — Fallbacks are frequent at scale.** Any change classified as
  config, test-support, or unmapped
  (`packages/vibehard/src/selector/changed.ts`, `classifyChangedFile`)
  forces a full run. Shared test helpers change often in large
  suites, so the fallback — though safe — erodes the benefit.
- **F7 — Precision degrades with shared code, by design.** Changing
  a layout or auth helper correctly selects most of the suite. This
  is honest signal (recorded in the manifest's risks), not a bug;
  the plan must not "fix" it by weakening the mapping.

## Would Rust help?

Short answer: technically yes on npm, strategically not yet.

### What could move, and what cannot

| Component | Lines (approx.) | Rust candidate | Expected gain |
|---|---|---|---|
| Indexer | 1,337 | Hard (see below) | Large, if faithful |
| Source-map remapping | 507 | Easy (pure function) | Small to moderate |
| Selector, lockfile, hashing | ~1,500 | Easy | Negligible |
| Verifier, servers, CLI orchestration | ~2,200 | Possible | None (waits on child processes) |
| Framework adapters | ~950 | **Must stay JS** | N/A |

The adapters cannot move: the Playwright adapter is a test fixture
executing inside the Playwright worker, the Puppeteer helpers run
inside the host test process, and the Cypress support file runs in
the browser bundle with no Node APIs. A "Rust rewrite" is therefore
always a Rust core behind a permanent JS layer.

The indexer is the hard part, and also the only place with real CPU
to win. It is not merely parsing: `computeReferences` resolves
identifiers through the TypeScript `TypeChecker`
(`getSymbolAtLocation`, `getAliasedSymbol`), follows re-exports, and
the indexer loads the *target project's* own `typescript` version
(`loadTypeScript`). Rust parsers (`oxc`, `swc`) parse much faster but
ship no TypeScript type checker. A port would have to re-derive the
reference graph from scopes and module resolution, risking a
different symbol graph — the exact artifact whose correctness the
whole product rests on — and would force an `INDEXER_VERSION` bump
invalidating every committed lockfile.

### Shipping Rust on npm is a solved problem

Three established routes (Biome, Rolldown, SWC, Lightning CSS, esbuild
are the usual references):

- **Platform binary packages**: a thin JS package plus per-platform
  binaries in `optionalDependencies`. Best if the CLI itself becomes
  Rust. Costs a build matrix (darwin arm64/x64, linux x64/arm64 in
  gnu and musl flavours, win32 x64).
- **N-API addon (napi-rs)**: best if Rust supplies hot functions to
  the existing JS. One binary per platform, stable across Node
  versions; costs marshalling and a JS fallback to maintain.
- **WASM**: one artifact, no matrix, no install scripts; slower, and
  filesystem/process access is awkward for this workload.

### Recommendation

Defer Rust. The plan below removes whole-repo work from the hot path,
which is worth orders of magnitude more than any constant factor.
Revisit a native port only for the parse-only extractor and the
source-map remapper, and only if profiling after Phases 1–2 shows
TypeScript parsing still misses the performance targets. Any such
port must pass the same extractor parity tests defined in Phase 1;
the type-checked full indexer remains the implementation of record
for `record` until a port proves an identical symbol graph.

## Target architecture

Three principles drive every phase below:

1. **Everyday paths are diff-proportional.** `vibehard test` and
   `vibehard explain` should cost ~O(C + touched files + E) with small
   constants — never O(F) full programs, never whole-repo hashing.
2. **Proof stays in `record`.** The full type-checked index remains
   the implementation of record for building touched sets. Selection
   trusts the lockfile and only needs *changed* symbol IDs plus
   hashes of *touched* symbols.
3. **Speed never buys unsoundness.** Each phase ships behind a parity
   or equivalence gate against the current behaviour, and anything
   not proven falls back to today's slower, safer path (or to a full
   run), with the fallback visible in diagnostics.

## Plan

Phases are ordered by impact per unit of risk. Phases 0–2 fix
selection latency and lockfile size; Phase 3 fixes recording; Phases
4–5 remove ceilings and reduce fallbacks. Phases 1 and 2 are
independent of each other and of Phase 3, and could be reordered, but
the order below delivers the everyday win first.

### Phase 0 — Instrumentation and a scale fixture

Nothing else in this plan can be judged without numbers.

Deliverables:

- Phase timings in `selectTests` and `verifyProject`, surfaced behind
  `--timing` (or `VIBEHARD_PROFILE=1`) and in `--json` output:
  discovery, git operations, head index, base index/worktree,
  hashing (with symbol counts), lockfile load, trust check,
  selection, filter proof, and per-test observation (server startup
  vs framework vs test).
- A generated scale fixture (generator script, not committed bulk):
  parameters for source files, symbols per file, shared-module
  fan-in, spec files, tests per spec, and touched symbols per test,
  with a small real app shape so coverage recording works end to end
  at reduced size. A pure selection variant generates a synthetic
  lockfile at full size (e.g. 3,000 files, 3,000 tests, K≈150) for
  benchmarking `selectTests` without recording.
- A `perf` npm script that runs the benchmark and prints the phase
  table; wired into CI as a non-blocking job initially, with results
  recorded so regressions are visible.
- Baseline numbers for the current implementation at the generated
  sizes, recorded in this document or the perf job output.

Exit criteria: every later phase can state its before/after numbers
at identical fixture sizes.

#### Phase 0 baseline (complete, measured 2026-10-20)

Implemented: `PhaseTimer` instrumentation behind `--timing` /
`VIBEHARD_PROFILE` for `test`, `record`, and `verify`; the
deterministic generator and runner in `packages/vibehard/perf/`;
non-blocking `.github/workflows/perf.yml`. Timing is opt-in and
proven not to change results or written lockfiles
(`test/timing.test.ts`, timing cases in `test/selector.test.ts` and
`test/verifier.test.ts`, `test/perf-fixture.test.ts`). The harness
also exposed and fixed a pre-existing CLI bug: large piped
`--json` output was truncated because the bin called `process.exit`
before its stdout write had flushed.

Environment: Apple M1 Pro, macOS (arm64), Node v23.5.0, base commit
`819f5c7` plus the Phase 0 working tree. Selection figures are
medians of 5 runs after one warm-up, `leaf` scenario (one narrowly
touched symbol edited), spawning the built CLI per run.

| Preset | Files / symbols | Tests / edges | Lockfile | Wall | `index.head` + `index.base` | Worktree + hashing | Lock load/trust/intersect | Selection total |
|---|---|---|---|---|---|---|---|---|
| smoke | 100 / 1,300 | 100 / 5,000 | 0.8 MB | 1,216 ms | 714 ms | 78 ms | 6 ms | 880 ms |
| default | 1,000 / 15,000 | 1,000 / 100,000 | 16.0 MB | 2,674 ms | 1,705 ms | 409 ms | 118 ms | 2,331 ms |
| large | 3,000 / 51,000 | 3,000 / 450,000 | 71.9 MB | 5,965 ms | 3,954 ms | 965 ms | 508 ms | 5,600 ms |

At `large`, the two full indexes plus base-worktree checkout/cleanup
and whole-repo hashing are 4,918 ms of the 5,600 ms selection total
(≈88%). The selection arithmetic itself (`selection.intersect`)
takes 43 ms for 450,000 edges. This confirms F1 and the Phase 1
priority: removing whole-repo indexing from selection is worth more
than every other selection optimisation combined. Lockfile loading
(377 ms at 71.9 MB) is the next term, confirming Phase 2.

Record baseline (`record-smoke`: 21 source files, 183 symbols, 10
trivial Playwright tests, one run): internal total 31,488 ms, of
which observations are 30,193 ms — `observation.frameworkRun`
27,578 ms over 20 observations (≈1.38 s each, dominated by
per-observation Playwright process/browser startup), server starts
2,097 ms, coverage mapping 112 ms. Discovery adds 800 ms and
indexing 490 ms. Even with near-empty tests, serial recording costs
≈3.0 s of observation per test, before any real test duration —
confirming F3 and the Phase 3 lanes/shards priority.

Caveats: generated modules are uniform and dependency-light, so
TypeScript program costs here are a lower bound for a real
application with framework types and a deep import graph; selection
presets use Puppeteer static discovery (54 ms at `large`), so
Playwright `--list` cost is not represented and is measured
separately by the record preset's discovery phase.

Proposed AT-S04 budget from this baseline: on the `large` fixture,
Phase 1 should bring selection total (excluding framework discovery)
from ≈5.5 s to ≤2 s on CI, ≤1 s with a warm parse cache. Not yet
enforced.

### Phase 1 — Diff-proportional selection

Replaces steps 3–5 of the current selection path. The full indexer
is untouched and remains in use for `record`/`verify`.

**Key observation.** `extractSymbols`
(`packages/vibehard/src/indexer/index.ts`) depends only on one
file's AST (`tsApi`, `sourceFile`, relative path). It is
`computeReferences` — needed only when *building* touched sets at
record time — that requires the `Program` and `TypeChecker`.
Selection needs symbol identities, ranges, and hash slices for a
small set of files, none of which requires a program.

**New algorithm for `selectTests`:**

1. Load config, resolve the git base, list changed files, and parse
   the patch — unchanged from today.
2. Read the lockfile *first* (today it is read after indexing) and
   fail fast on a missing or unreadable lockfile.
3. Discover tests (unchanged; discovery optimisation is Phase 4).
4. Compute the touched union `U`: every symbol ID in the lockfile
   entries of still-discovered tests, and the set `Fᵤ` of files
   those symbols live in.
5. Determine tsconfig membership without a program: reuse
   `loadProgramInputs`, which already returns the parsed file list
   before `createProgram` is called. A changed app file that is in
   neither this list nor `Fᵤ` keeps today's behaviour (no symbols →
   unmapped lines → unsafe), preserving the current gate for files
   outside the indexed universe.
6. Parse-only extraction at head for `Fᵤ ∪ changed app files` only:
   `ts.createSourceFile` (parent nodes set, script kind by
   extension, the project's own TypeScript as today) feeding the
   existing `extractSymbols`, plus asset symbols for those files.
   Apply the existing `filterSymbols` include/ignore/testDir rules.
7. Hash only what is needed: head hashes for `U` plus all symbols of
   changed head files, using `hashSymbolSources` on that subset
   (the shape `hashesForTouched` already uses).
8. No base worktree. For changed app files only, fetch base text via
   a single batched `git cat-file --batch` (or `git show` per file),
   run the same parse-only extraction, and hash symbols of those
   files that are in `U` plus all base symbols of the file. For
   touched symbols in files the diff does not list, base hash equals
   head hash *by construction of the diff*; the trust check uses
   that identity instead of a base index. If a touched file cannot
   be proven unchanged (not tracked at base, unreadable, filtered
   differently at either side), the run is unsafe — as today.
9. Compute changed symbols with the existing
   `computeChangedSymbolsForFile`, classify files with the existing
   `classifyChangedFile` (asset files derived from lockfile touched
   IDs plus the parse of changed importers), run the existing trust
   logic against the subset hashes, and select as today.

**Cache.** Persist parse-only symbol records (without `references`)
keyed by `sha256(file text) + INDEXER_VERSION + TypeScript version +
relative path` under the git common dir
(`git rev-parse --git-common-dir`), so the cache is shared across
worktrees, never committed, and survives between runs. Writes must
be atomic (temp file + rename, as `writeLockfile` does) and tolerant
of concurrent writers and corruption (any cache doubt → recompute).
Bound the cache size with simple eviction. The same cache serves
`vibehard explain`, which today also pays a full `indexProject`.

**Parallelism (only if Phase 0 says so).** If parsing the touched
file set still dominates after caching, shard files across
`worker_threads`. Extraction is per-file and side-effect free, so
this is mechanical; measure structured-clone transfer cost before
committing to it.

**Correctness gates (all required before the fast path defaults on):**

- *Extractor parity:* for every source file in `fixtures/tiny-app`,
  all examples, `packages/vibehard` itself, and the AST-forms
  fixtures (`test/ast-forms.test.ts`), parse-only records equal
  `indexProject` records with `references` removed — IDs, kinds,
  ranges, and `hashSlices` byte-for-byte.
- *Selection parity:* old and new paths produce identical
  `SelectionResult`s (selected tests, reasons, changed symbols,
  unsafe reasons) across the selector/conformance suites and a
  mutation series over the examples.
- *No-program proof:* a test asserts the fast path performs no
  `createProgram` call and creates no worktree (instrumentation
  counters from Phase 0).
- Ship behind an opt-in flag/config for one release; on any internal
  inconsistency the fast path reports a diagnostic and falls back to
  the current algorithm rather than guessing.

Expected result: selection cost becomes
`discovery + git + parse(touched ∪ changed files) + hash(touched ∪
changed symbols)`, independent of total repo size. On the tiny
fixture the 1.98 s dry-run floor should collapse to discovery time
plus tens of milliseconds.

#### Phase 1 results (implemented, opt-in, measured 2026-10-20)

Implemented as `--fast-select` / `VIBEHARD_FAST_SELECT=1` on `test`
and `explain` (`SelectOptions.fastSelect` programmatically), default
off for one release; the flag deliberately does not live in
`VibehardConfig`, since `configHash` covers the whole config. The
fast path is `src/selector/fast-select.ts` over the parse-only
extraction now exported from the indexer (`createProjectParser`,
`loadProjectFileList`); the cache
(`src/selector/parse-cache.ts`) stores symbol records plus
per-symbol hashes under `<git-common-dir>/vibehard-cache/v1/`,
atomic writes, 256 MB oldest-first eviction, `VIBEHARD_NO_CACHE=1`
to disable. Any fast-path failure falls back to the full algorithm
with a `fast selection unavailable (…)` diagnostic.
`record`/`verify`, lockfile v2, and `INDEXER_VERSION` are untouched;
no re-record is needed.

Gates: AT-S01 passes over `fixtures/tiny-app`, all examples,
`packages/vibehard` itself, and a synthetic AST-forms project
(`test/parse-parity.test.ts`). AT-S02 passes over a 16-mutation
series on `tiny-app` (no-change, leaf/constant/whitespace edits,
spec/config/unmapped/membership-gated edits, add/delete/rename,
missing lockfile, imported-asset edit, CRLF-smudged touched file,
git-ignored touched symbol), plus fast/full `explain` parity
(`test/fast-select.test.ts`). AT-S03 asserts no `index.*` /
`git.baseWorktree.*` timing phases and an unchanged
`git worktree list`.

Two findings while implementing the sketch above: in
`git cat-file --filters --batch` output the header size is the
*pre-filter* blob size while the bytes are post-filter, so a
multi-object filtered stream cannot be framed by size — base
contents are therefore read one file per process (lookup stays a
single `--batch-check`), and tracked-at-base proof is one
`git ls-tree -r` walk after the per-file `cat-file <rev>:<path>`
check measured ~0.4 ms per touched file (1.3 s at `large`).
Known precision-only divergences, both in the safe direction
(full run instead of mapped): a changed file outside both the
tsconfig file list and the touched union that today's `Program`
would reach only through imports, and a changed asset whose only
importers are neither touched nor changed.

Environment: Apple M1 Pro, macOS (arm64), Node v23.5.0, base commit
`819f5c7` plus the Phase 0+1 working tree; medians of 5 runs after
one warm-up, `leaf` scenario, built CLI (selection total excludes
framework discovery where stated):

| Preset | Full (Phase 0 baseline) | Full (final session) | Fast, cold cache | Fast, warm cache |
|---|---|---|---|---|
| smoke | 880 ms | 869 ms | — | 118 ms |
| large | 5,600 ms | 5,548 ms | 1,552 ms | 1,018 ms |

At `large`, the two full indexes, worktree, and whole-repo hashing
(≈4.9 s of the full total) are replaced by membership (33 ms),
touched union (58 ms), parse (276 ms warm / 811 ms cold), base
texts + tracked check (33 ms), and subset hashing folded into the
parse cache hits. Excluding framework discovery, that is 1,498 ms
cold and 968 ms warm — inside the proposed AT-S04 budget (≤2 s
cold, ≤1 s warm), which remains unenforced in CI. Closing the
last of the gap did not need `worker_threads`: profiling showed
parsing itself is only ≈340 ms at `large`, while synchronous
cache writes cost ≈1.2 s cold. The follow-up therefore made
file/cache I/O asynchronous and pooled (libuv threadpool,
32 tasks in flight), gated prune directory scans behind a
measured size estimate (scanning every 64 writes was quadratic in
entry count), snapshotted cache directory entries so cold runs
skip one doomed read per file, overlapped the lockfile read with
the git/discovery subprocesses, deduplicated the trust check by
(symbol, expected-hash) pair, and sorted only matched symbols in
the selection loop. Because several phases now overlap, fast-path
phase durations no longer sum to the selection total (the
`lockfile.load` phase reports the loader's own duration, and a
git phase can be inflated by main-thread work queued ahead of
its completion callback). The largest remaining warm term is
still the 72 MB v2 lockfile parse (≈390 ms of loader time,
mostly hidden behind subprocess waits) — Phase 2's concern.

Follow-up (2026-10-24): after the one-release opt-in soak, the
fast path is the default selection algorithm and the
`--fast-select` CLI flag is removed. `VIBEHARD_FAST_SELECT=0` (or
programmatic `fastSelect: false`) forces the full-index reference
algorithm, which is retained as the exception fallback and the
AT-S02 parity oracle; the perf harness drives it via
`--full-select`. Historical `--fast-select` spellings below
describe the opt-in period.

### Phase 2 — Lockfile v3: interned symbols

New format version 3 in
`packages/vibehard/src/verifier/lockfile.ts`. The recorded *data*
does not change, so no re-record is required.

Sketch:

```jsonc
{
  "version": 3,
  "framework": { "name": "playwright", "version": "…" },
  "configHash": "…",
  "graphVersion": 3,
  // each (id, hash) pair once, sorted; tests reference indexes
  "symbols": [
    { "id": "src/lib/cart.ts#Cart.addItem", "h": "<sha256>" }
  ],
  "tests": {
    "<testId>": {
      "file": "e2e/checkout.spec.ts",
      "titlePath": ["checkout applies a coupon"],
      "touched": { "direct": [0, 5], "referenced": [9], "module": [12], "class": [3], "asset": [7] }
      // optional: "alwaysRun": "reason"
    }
  }
}
```

Design points:

- Intern by **(symbol ID, hash) pair**, not ID alone. Partial
  re-records merge entries recorded against different source states;
  a pair table preserves those exactly, while the common case
  (whole-suite record) still stores each symbol once.
- Tests reference sorted integer index arrays grouped by touch kind,
  replacing two string-keyed maps per test. Entries stay sorted for
  stable serialization and minimal diffs; write compact JSON (or
  one line per test) instead of 2-space pretty-printing.
- Estimated size at 5,000 tests × 200 touched: ~10 MB instead of
  ~144 MB, dominated by the symbol table.
- Readers normalise v2 and v3 into the same in-memory shape; writers
  emit v3. `record`/`verify` therefore migrate a v2 lockfile on
  their next successful write with no user action. Round-trip test:
  v2 → internal → v3 → internal is lossless, including
  `checkLockfile` behaviour.
- The trust check becomes per-symbol, not per-edge: compare each
  interned `(id, hash)` against the base/head hash once.
- Build an in-memory inverted index (symbol → tests) on load and use
  it in the selection loop and in `explain`. This is a small win
  today (the scan is already fast) but makes selection
  O(changed symbols + selected tests) and keeps it there as E grows.

Open decision (see Open Questions): single compact file as above, or
split per spec file under a lock directory to reduce merge conflicts
at the cost of many files. Default proposal: single file now;
revisit only if merge pain is reported.

#### Phase 2 results (implemented, measured 2026-10-20)

Implemented in `packages/vibehard/src/verifier/lockfile.ts`: readers
accept v2 and v3 and normalize both into the existing in-memory
shape (`VibehardLockfile.version` is now `3`); writers emit only v3,
so `record` and non-CI `verify` migrate a v2 lockfile on their next
successful write. `INDEXER_VERSION`, the recorded data, and every
result shape are unchanged; no re-record is needed. Layout is a
single file (the open decision above, taken): pretty-printed header,
one interned `{"id","h"}` symbol per line, one test per line,
trailing newline. Deviations from the sketch, all found by auditing
the code and the seven committed lockfiles (177 edges, zero orphan
or missing hashes): all five touch kinds get index groups (the sketch
showed three; `class` and `asset` occur in real files); a touched
symbol with no recorded hash interns without `h` and keeps failing
the trust check exactly like a missing v2 hash; hashes for symbols a
test did not touch are dropped on migration (no consumer reads
them). Because integer indexes could silently mis-select if corrupt,
the v3 reader validates strictly — sorted duplicate-free symbol
table, 64-hex hashes, in-range strictly-increasing indexes, known
kinds, no symbol referenced twice per test, no unknown fields — and
a newer-than-v3 file says "upgrade vibehard". Older vibehard
versions cannot read v3, so this ships as 0.2.0. Selection, the
trust check, the fast path's touched union, and `explain` now share
an in-memory inverted index (`buildSymbolTestIndex`, internal) and
one intersect implementation; trust is checked per distinct
(symbol, expected-hash) pair over discovered tests.

Gate: AT-S05 passes in `test/lockfile-v3.test.ts` (28 tests: v2 →
internal → v3 → internal losslessness incl. pair interning,
`alwaysRun`, and missing hashes; byte-canonical committed files;
`checkLockfile`/trust parity v2 vs v3; 15 strict-validation
rejections; ≥5× size assertion). Six committed lockfiles were
migrated by parse+serialize and the seventh
(`fixtures/tiny-app/vibehard.puppeteer.lock.json`) by a passing
`verify` during the test run itself; all seven were verified
semantically identical to their v2 bytes (per-test touched kinds
and hashes, compared via plain JSON against HEAD). Tests that had written lockfiles with raw
`JSON.stringify` now go through `writeLockfile`, since in-memory and
wire shapes intentionally differ.

Environment: Apple M1 Pro, macOS (arm64), Node v23.5.0, base commit
`41b60f7` plus the Phase 2 working tree; medians of 5 runs after one
warm-up, `leaf` scenario, built CLI:

| Preset | Lockfile v2 → v3 | `lockfile.load` | `lockfile.trust` | `selection.intersect` | Selection total |
|---|---|---|---|---|---|
| smoke, fast warm | 0.8 MB → 186 KB (4.5×) | 9 ms | — | — | 100 ms (Phase 1: 118 ms) |
| large, full | 71.9 MB → 8.9 MB (8.0×) | 377 → 214 ms | 100 ms | 43 → 1.5 ms | 5,600 → 4,717 ms |
| large, fast warm | 71.9 MB → 8.9 MB (8.0×) | ≈390 → 190 ms | 90 ms | 1.4 ms | 1,018 → 855 ms |
| large, fast cold | 71.9 MB → 8.9 MB (8.0×) | 194 ms | 99 ms | 1.3 ms | 1,432 ms |

Reading the table honestly: size is the headline win (8.0× at
`large`, inside the ~10 MB estimate for the sketch's larger case),
and the inverted index removes the intersect scan as a term.
Load time improves only ~1.8× despite 8× fewer bytes, because v2's
cost was `JSON.parse` in native code while v3 additionally validates
and builds the same 450,000-edge in-memory maps in JS; the fast
path's touched-union phase grew (58 → 143 ms) because it now also
builds the inverted index that trust and intersect reuse. Net
fast-warm selection still improves (≈968 → ≈810 ms excluding
discovery) and stays inside the AT-S04 budget. Sort-order diff
churn, measured on the committed `two-frontends` file by simulated
re-records: adding one early-sorting symbol touched by one test
changes 7 lines (the new symbol line plus every test line whose
indexes shift), a late-sorting symbol 5 lines, and a single-symbol
hash change 7 lines. Churn therefore scales with referencing tests,
as predicted; accepted for content-determined ordering (AT-11,
Phase 3 shard merges), revisit only on reported merge pain.

### Phase 3 — Parallel, sharded, and incremental recording

Three steps, in increasing order of risk. Each preserves the current
per-test observation semantics until its own equivalence gate passes.

**3a. Lanes (same machine).** Replace the sequential loop in
`verifyProject` with a bounded lane pool (`record`/`verify --jobs N`,
default 1). Each lane owns its servers, ports, and artifact
directories and runs its tests sequentially — exactly today's
observation, N at a time. Results are merged deterministically
(sorted by test ID) before any lockfile write. Constraints to
document and enforce: the app under test must tolerate N parallel
instances (ports are already allocated dynamically via
`{port}`/`freePort`; databases, queues, and fixed external resources
are the user's responsibility, hence opt-in). Gate: `--jobs 4`
produces lockfile entries identical to `--jobs 1` on all examples.

**3b. Shards (across machines).** Add `--shard <i>/<n>` to
`record`/`verify`: deterministic assignment by stable hash of test
ID over the sorted discovered set, so shards are disjoint and
complete. A shard run writes a partial artifact (its entries plus
provenance: config hash, framework name/version, graph version,
indexer version, and a source-state fingerprint such as HEAD SHA
plus a dirty-tree marker) instead of touching the lockfile. A merge
step (`record --merge <files…>`, exact spelling to be decided)
validates that all shards agree on provenance and that their union
covers the intended test set, then writes the lockfile once,
atomically. This is the contract that makes recording a
multi-thousand-test suite a routine CI matrix job. Gate: a sharded
record merges to a byte-identical lockfile to the unsharded record
on the examples; mismatched-provenance shards are refused.

**3c. Incremental record.** Add a mode that re-records only tests
selected by the current change set, newly discovered tests, and
tests whose spec file changed — i.e. run selection first, then
observe that subset, merging entries as filtered records already do
via `mergeAndWriteLockfile`. Soundness rests on the same argument
selection itself uses (a test whose touched symbols are all
hash-unchanged executes the same symbols), plus the existing
two-endpoint trust check at `test` time. Because this leans on the
model rather than re-proving it, the documented CI recipe must pair
incremental records on PRs with a scheduled full `verify` (e.g.
nightly) that re-observes everything. If selection reports any
unsafe reason, incremental record refuses and requires a full
record. Gate: on a mutation series over the examples, incremental
record + `verify --ci` agrees with full record + `verify --ci`.

**3d. Server reuse within a lane (research spike, later).** The
remaining per-test overhead is server + framework startup. Reusing
a server across the tests of one lane requires per-test coverage
deltas instead of exit-flushed `NODE_V8_COVERAGE`. Candidates:
the Node Inspector protocol (`Profiler.startPreciseCoverage` /
`takePreciseCoverage` per test window, attributing ranges whose
counts increased), or a small preload agent (`node:v8`
`takeCoverage()`) snapshotting on request. Either must prove, on
every example, touched sets identical to the restart-per-test
method before it can be enabled; any snapshot failure falls back to
a restart. Concurrency stays at one in-flight test per server, so
attribution remains unambiguous. Only after 3d could client-side
runs also be batched into one framework invocation per lane;
do not batch before deltas exist.

#### Phase 3 results (3a–c implemented, measured 2026-10-22)

Implemented in `packages/vibehard/src/verifier/run.ts`,
`packages/vibehard/src/verifier/shards.ts`, and
`packages/vibehard/src/verifier/servers.ts`; CLI spellings (the open
decision below, taken): `record`/`verify --jobs <n>`,
`--shard <i>/<n>` (1-based), `--shard-out <file>`,
`record --merge <files…>`, and `record --incremental [--base <ref>]
[--fast-select]`. Results now report `jobs`, `shard`,
`shardArtifact`, and `incremental`. Programmatically these are
`VerifyProjectOptions.jobs`/`shard`/`shardOut`/`incremental`/
`baseRef`/`fastSelect` and a new `mergeShardArtifacts`.

- **3a lanes.** A bounded pool runs the unchanged per-test
  observation (`runOneTest`/`observeOnce`: own servers, own
  framework process, record-twice) and replays outcomes in
  discovered order, so reports and lockfile bytes match a serial
  run. Default `--jobs 1`. Two hazards the serial code hid are
  fixed in `servers.ts`: `freePort` now reserves handed-out ports
  until a listener claims one, and server starts are serialized
  process-wide, so lanes cannot collide in the probe-to-bind
  window. A thrown usage error stops scheduling, settles in-flight
  observations, and propagates; ordinary test failures do not
  cancel siblings.
- **3b shards.** Assignment is `sha256(testId) mod n` over the
  sorted discovered set. A record shard never touches the lockfile;
  it writes one artifact (entries, per-test statuses, and
  provenance: config hash, framework name/version, graph version,
  HEAD + dirty source state, and a discovered-set fingerprint).
  `record --merge` is a pure validation (`mergeShardArtifactList`)
  plus one lockfile write: exactly one artifact per shard index,
  agreeing provenance (checked again against the merging project's
  current config/framework), only `recorded`/`always-run`
  statuses, every entry provably in its shard, and a union equal
  to the recorded discovered set — anything else is refused
  without writing. Empty shards still write artifacts, so a merge
  can prove they ran. `--shard` is refused with test filters.
- **3c incremental.** `record --incremental` runs `selectTests`
  first (honouring `--base`/`--fast-select`), refuses on any unsafe
  reason (a missing lockfile included), then re-observes exactly
  `selection.selected` — changed-symbol, unrecorded,
  spec-changed, and alwaysRun tests — via an internal exact-ID
  subset that errors if discovery loses a selected test. Because
  discovery is complete, it also prunes entries for deleted tests;
  with zero selected tests it observes nothing and only prunes.
  The documented contract stands: pair it with a scheduled full
  `verify`.

Gates: AT-S06 passes as byte-identical lockfiles for `--jobs 4`
vs `--jobs 1` plus repeated `--jobs 8` verifies
(`test/record-lanes.test.ts`) and for a merged 3-shard record vs
the serial record, with mismatched-provenance merges refused
(`test/record-shards.test.ts`). AT-S07 passes over leaf-edit,
no-change, new-test, and deleted-test mutations on a git copy of
`fixtures/tiny-app` — incremental and full record reach identical
lockfile bytes from the same starting lockfile, followed by a
passing `verify --ci` — and refuses unsafe and missing-lockfile
changes (`test/record-incremental.test.ts`).

Recording numbers (`record-smoke`: 21 files, 183 symbols, 10
tests, 134 edges; medians of 3 single runs, same machine as the
table below): serial 30,868 ms at `--jobs 1`, 11,171 ms at
`--jobs 4` (2.8× on 10 tests; per-phase `frameworkRun` time is
summed across lanes, so only wall and `observation.total`
≈9.7 s are comparable). Incremental on the same fixture after a
one-module leaf edit (single run, lockfiles verified byte-identical):
6,059 ms observing 1 test vs 30,118 ms observing all 10 — the
remainder is selection, indexing, and discovery that an incremental
record still pays in full today. 3d remains unimplemented.

#### Before/after against the pre-scaling baseline (`819f5c7`)

Measured 2026-10-22 on one machine in one session (Apple M1 Pro,
macOS arm64, Node v23.5.0): BEFORE is a pristine detached worktree
of `819f5c7` (v0.1.0, the last commit before scaling work), AFTER
is `b4c7c49` (Phases 0–3) plus the perf-runner flags used here.
The BEFORE tree has no perf harness, so the current
`packages/vibehard/perf/*.mjs` were copied into it as untracked
tooling only: every symbol ID, hash, and lockfile byte then comes
from that tree's own build (its `writeLockfile` emits v2). Two
shims were needed, neither touching the code under measurement:
`--no-timing` (the flag does not exist at `819f5c7`), and capturing
BEFORE `--json` through a temp file, because that CLI truncates
large piped output (the bug Phase 0 fixed). Selection figures are
medians of 5 runs after one warm-up, `leaf` scenario, external
wall clock of `vibehard test --dry-run --json` (CLI startup and
JSON output included); fast-path `selection total` is the
AFTER-only timed phase. Record figures are medians of 3 single
runs.

| Preset | Before (v0.1.0) | After, full path | After, `--fast-select` warm | Lockfile before → after |
|---|---|---|---|---|
| smoke (100 tests, 5k edges) | 1,171 ms | 1,219 ms | 438 ms (selection 109 ms) | 811 KB → 186 KB (4.3×) |
| default (1,000 tests, 100k edges) | 2,581 ms | 2,615 ms | 661 ms (selection 334 ms) | 16.0 MB → 2.4 MB (6.6×) |
| large (3,000 tests, 450k edges) | 5,779 ms | 6,024 ms | 1,342 ms (selection 1,005 ms) | 71.9 MB → 8.9 MB (8.0×) |
| large, fast cold cache | — | — | 1,955 ms (selection 1,616 ms) | 71.9 MB → 8.9 MB |
| record-smoke (10 tests) | 29,937 ms serial | 30,868 ms `--jobs 1` | 11,171 ms `--jobs 4` | 23 KB → 12 KB |

Reading it honestly: the default full selection path is *not*
faster than before — batch medians at `large` ran 5.3–5.8 s
before and 5.9–6.0 s after, because the algorithm is deliberately
the same proof and v3 validation plus the inverted-index build
roughly offset the smaller parse. The scaling wins are the ones
the plan aimed at: `--fast-select` selection (still opt-in) is
≈4.3× on wall clock at `large` and makes cost diff-proportional,
lockfiles shrink 4–8× on every run path, recording divides by
lanes/shards, and incremental record skips observation work the
change cannot affect. The selected test IDs matched the
generator's ground truth on both sides of every preset.

### Phase 4 — Delegation and output ceilings

Independent small fixes in the drivers
(`packages/vibehard/src/verifier/*-runner.ts`) and in
`packages/vibehard/src/verifier/servers.ts`:

- **Chunked delegation.** Group selected tests by file. If every
  discovered test in a file is selected, pass the bare file; else
  pass `file:line` entries in chunks under an argv byte budget
  (~24 KB to stay safe on Windows). Run chunks sequentially (or with
  the framework's own parallelism inside each), aggregate exit
  codes — any failing chunk fails the run — and run `proveFilter`
  per chunk so the proof obligation is unchanged. Apply the same
  chunking to Cypress `--spec` lists and keep Puppeteer's per-file
  grouping, optionally with bounded concurrency across file groups.
- **Streaming process output.** Add a `spawnStreaming` variant that
  inherits stdio for plain runs (framework output is the user's to
  watch) and retains only a bounded tail for diagnostics/JSON mode.
  Keep `spawnCapture` for short, bounded commands (git, `--list`),
  but collect `Buffer` chunks and join once instead of string
  concatenation.
- **Discovery.** For Playwright, write the JSON report to a file
  (`PLAYWRIGHT_JSON_OUTPUT_NAME`) and parse from disk instead of
  buffering stdout. Longer term, cache discovery keyed by the
  hashes of spec files + framework config + framework version in
  the Phase 1 cache directory; any spec change invalidates it.
  Static (AST) discovery as primary for Playwright is *not*
  proposed: generated/parametrised tests and project matrices make
  the framework the only authority. It may be used as a cache-key
  cross-check, never as the source of truth.
- **Timeouts.** The fixed whole-run timeouts (up to 1,800 s) stay,
  but chunked runs should apply the budget per chunk so a large
  selected set is not killed for aggregate size alone.

Gate: a generated suite whose selected set exceeds the argv budget
runs to completion with identical results to one unchunked run
(where the platform permits), and `proveFilter` failures still fall
back to a full run.

#### Phase 4 results (implemented, measured 2026-10-23)

Implemented in `packages/vibehard/src/verifier/delegation.ts` (new:
`ARGV_BUDGET_BYTES` = 24 KiB, `argvBytes`, `groupRunnableByFile`,
`packChunks`), the three `*-runner.ts` drivers (`planPlaywrightChunks`,
`planCypressChunks`, `planPuppeteerChunks`), and
`packages/vibehard/src/verifier/servers.ts` (`spawnStreaming`,
`spawnDelegated`, `mergeSpawnResults`, `truncateToTail`). No lockfile,
config, or `INDEXER_VERSION` change; the budget is a code constant
(deliberately not config, so `configHash` is untouched), overridable
only programmatically via `argvBudgetBytes` for tests.

- **Chunking.** Playwright: fully selected files collapse to bare
  positionals, partial files to `file:line`, packed under the budget
  counting the fixed command prefix; `proveFilter` proves per chunk
  and compares the union, so the proof obligation is unchanged.
  Selected runs gain an optional `discovered` driver input (without
  it nothing is ever claimed whole-file). Cypress: fully selected
  specs chunk separately with no title filter — the `VIBEHARD_ONLY`
  filter matches titles across every spec in an invocation, so
  mixing would be wrong — and partial specs pack counting both
  `--spec` and the encoded title payload, which the proposal did not
  name and which is in fact the first ceiling hit (≈78 KB at 1,000
  tests, already past the Windows limit, versus ≈23 KB of Playwright
  positionals). Full (unselected) Cypress runs chunk their spec list
  too. Puppeteer: per-file invocations as before, titles now split
  when the `--test-name-pattern` would exceed the budget; cross-file
  concurrency was not added (same shared-resource reasoning that
  makes `--jobs` opt-in). Every chunk runs even when an earlier one
  fails (first non-zero exit wins): fail-fast would skip proven
  tests. A single indivisible test over budget fails closed with a
  usage error rather than delegating truncated arguments.
- **Streaming.** Plain delegated runs take an output mode:
  `capture` (programmatic default, whole output as before),
  `stream` (tee live to the parent streams, retain a 64 KiB tail per
  stream), or `tail` (bounded tail, no echo). The CLI `test` command
  uses `stream` for text output and `tail` under `--json`; results
  report `truncated`/`streamed`/`chunks`, and the text report never
  re-prints streamed output. Observation runs stay captured.
  `spawnCapture` now Buffer-joins stderr like stdout.
- **Discovery.** Playwright `--list` writes its JSON report to a
  per-call temp file via `PLAYWRIGHT_JSON_OUTPUT_FILE` (which takes
  precedence over the name/dir variables) and parses from disk; a
  user-set value is overridden for that spawn only. The *discovery
  cache* was measured and rejected for this phase: there is still no
  large-scale Playwright `--list` baseline showing it dominating
  after the file change (selection presets use Puppeteer static
  discovery; `record-smoke` discovery was 800 ms for 10 tests), and
  its invalidation surface is the riskiest part of the sketch.
  Revisit only with a profile that shows listing dominating.
- **Timeouts** are per chunk invocation (1,800 s each); aggregate
  wall for a multi-chunk selection can now exceed 30 minutes by
  design, and `framework.run` timing details report the chunk count.

Gate: AT-S08 passes as planner units plus a real tiny-app Playwright
run whose budget is shrunk to force multiple chunks (chunked and
unchunked runs execute the identical test IDs; a tampered claimed
ID surfaces as a `proveFilter` problem, which `testProject` turns
into the existing full-run fallback) in `test/delegation.test.ts`
and `test/delegation-chunks.test.ts`, wired into CI's fast and
verifier+selector jobs. Planner measurements
(`packages/vibehard/perf/delegation.mjs`, synthetic partial-file
selections, this machine): at 3,000 selected tests the unchunked
Playwright argv would be 72,000 bytes (3 chunks after, max 24,576)
and the Cypress `--spec` + title payload 239,362 bytes (10 chunks,
max ≈24.5 KB); at 10,000 tests, 240,000 → 10 chunks and 804,729 →
33 chunks, every chunk within budget with no test dropped.
Selection perf is unchanged by construction (delegation is not on
the dry-run path; `smoke` preset re-measured in line with Phase 3).
CI is Linux-only, so the Windows ceiling itself is validated by the
byte-budget arithmetic and planner tests, not by spawning at the
real limit.

Verification note: one full parallel `vitest run` on this machine
showed 5 failures that all pass when run in CI-shaped groups (every
test file re-run individually or in its CI group, Cypress after one
flaky first attempt) — the suite's per-file `npm run build` hooks
and browser loads race under 29-file parallelism. Recorded here
because "full suite parallel on a laptop" is not a gate this repo
has ever claimed; CI groupings are.

### Phase 5 — Fewer full-run fallbacks

The fallback is safe but expensive; at scale it must be rare.

- **Test-support mapping.** Build a static import graph over the
  test directory (specs, fixtures, helpers, setup files) using
  TypeScript module resolution from the parsed `tsconfig` — no
  `Program` needed, resolutions cached as in Phase 1. A changed
  support file then selects exactly the specs that transitively
  import it, instead of forcing a full run. Every spec's transitive
  support set is computed at selection time from current source;
  unsupported edges (dynamic `import()` with non-literal specifier,
  `require` of a computed path, unresolved aliases) classify the
  change as unmapped, preserving today's behaviour. Global setup
  files declared in the framework config are roots for every spec.
  Gate: mutations to helpers in the examples select exactly their
  importing specs; any unresolvable helper still forces a full run.
- **Monorepo scoping (documentation + config ergonomics).** The
  supported large-repo shape is one `vibehard.config` and lockfile
  per app, with `include` narrowed to that app, run per app in CI.
  Document that shared workspace packages must lie inside the
  indexed root (or be covered by `include`), otherwise changes to
  them are invisible to selection. Multi-root indexing (several
  source roots feeding one lockfile) is a possible later feature;
  it is explicitly out of scope for these phases.
- **Finer config classification (later, optional).** Today any
  `package.json`/lockfile/config change is unmapped. A later phase
  may map provably irrelevant edits (e.g. `package.json` fields
  other than dependencies and scripts) — only with an allowlist and
  fail-closed parsing. Not required for scale; listed so it is not
  done ad hoc.

#### Phase 5 results (implemented, measured 2026-10-24)

Implemented in `packages/vibehard/src/selector/support-graph.ts`
(new: `resolveChangedSupportFiles`, `supportFilesBySpec`) over a
parse-only module resolver exported from the indexer
(`createModuleResolver`: `scanImports` + `resolveSpecifier` on the
project's own TypeScript copy and parsed `tsconfig` options, no
Program), wired identically into both selection paths via one
shared helper (`resolveChangedSupportSelection` in
`selector/select.ts`, timing phase `support.graph`). Selected tests
gain the additive reason `test-support-changed`. No lockfile,
config, `INDEXER_VERSION`, or CLI change, and no opt-in flag: the
mapped subset is provable and every other support change keeps
today's exact unsafe string and full run.

Deviations from the sketch above, each in the safe direction:

- **Scope** is exactly today's `test-support` classification
  (non-spec files under `testDir`); `classifyChangedFile` is
  unchanged. Helpers outside `testDir` (shared `test-utils/`,
  Cypress's `cypress/support/`, which sits outside its
  `cypress/e2e` testDir) keep their current handling.
- **No framework-config roots.** Framework configs are never parsed
  or executed to find global setup files. Instead a changed support
  file with zero importing specs stays unmapped, which covers
  implicitly loaded setup/support files inside `testDir` — the
  pre-existing "unimported `e2e/support.ts` is unsafe" test passes
  unchanged.
- **Narrow eligibility:** only source files changed by edit/addition
  map. Deleted helpers stay unsafe (a head graph cannot see their
  old importers — head-only edges are sound for edits because
  removing an edge means editing the importing file, which is then
  itself a changed spec/support/app file). Non-source fixture files
  stay unsafe (commonly `fs`-read; an import graph cannot disprove
  that).
- **Bounded traversal:** nodes are discovered specs plus files under
  `testDir`; edges into app code are leaves, so page objects
  importing app constants never pull in the app graph, and a helper
  reachable only through app code has zero importers and stays
  unmapped. Any non-literal `import()`/`require()`, `createRequire`,
  unreadable file, or unresolvable local/alias specifier in a
  traversed file voids the whole mapping (diagnostic
  `test-support mapping unavailable: …`); unresolved bare package
  specifiers are external leaves. The graph is built lazily, only
  when an eligible support change exists, and any internal failure
  degrades to unmapped rather than throwing.
- **No resolution cache.** Measured first, per below; revisit only
  if `support.graph` shows up dominating a real profile.

Gate: AT-S09 passes over a two-spec tiny-app mutation series
(exclusive helper, shared helper, two-hop barrel chain, deleted
helper, non-literal dynamic import) in `test/selector.test.ts`,
with fast/full parity over the mapped and unprovable cases in
`test/fast-select.test.ts` (AT-S02 list extended; AT-S03's zero
Program/worktree assertion unaffected), graph-unit coverage in
`test/support-graph.test.ts`, and an incremental-record mutation
(helper edit re-observes only the importing spec, lockfile equal to
full record, `verify --ci` clean) in `test/record-incremental.test.ts`.
Monorepo scoping ships as documentation in both READMEs (one config
and lockfile per app, narrowed `include`, per-app CI runs, shared
packages inside the indexed root); no config ergonomics code was
needed. Finer config classification stays deferred as proposed.

Perf (new `support` scenario in the scale fixture: every spec
imports a shared helper and its group helper; mutating one group
helper must select exactly that group's specs — the runner checks
the generator's ground truth each repetition): at `large`
(3,000 tests, 300 spec files, 450k edges) with `--fast-select`,
wall median 1,486 ms and selection total 1,127 ms (≈1,066 ms
excluding discovery — inside the AT-S04 ≤2 s budget), of which
`support.graph` is 132 ms over 331 parsed test files; exactly 100
tests (one group) selected. The `leaf` scenario on the same
fixture shows no `support.graph` phase and a 1,058 ms selection
total, confirming zero cost when no support file changed.

## Sequencing and expected impact

| Phase | Fixes finding | Primary risk | Expected impact |
|---|---|---|---|
| 0. Instrumentation + fixture | — (enables all) | None | Decisions become measurable |
| 1. Diff-proportional selection | F1, F2 | Extractor parity | `test` drops from O(F) programs to O(C + touched) parsing |
| 2. Lockfile v3 interning | F4 | Format migration | ~10–15× smaller lockfiles; per-symbol trust check |
| 3a–c. Lanes, shards, incremental | F3 | App parallel-safety; merge rules | Record wall-clock ÷ lanes/shards; PR records touch only affected tests |
| 3d. Server reuse (spike) | F3 (startup overhead) | Coverage-delta equivalence | Removes per-test server startup |
| 4. Chunking + streaming | F5 | Per-framework quirks | No argv/memory ceilings on large selections |
| 5. Support graph + scoping | F6 | Resolution edge cases | Helper edits stop forcing full runs |

F7 (shared-code fan-out) has no phase: it is correct behaviour.

## Proposed acceptance tests

Numbered in the manifest's style, to be folded into its acceptance
list when a phase is scheduled:

- **AT-S01 (extractor parity):** parse-only extraction equals
  `indexProject` extraction (minus `references`) for every source
  file in the fixtures, examples, and `packages/vibehard/src`,
  including all cases in `test/ast-forms.test.ts`.
- **AT-S02 (selection parity):** fast-path selection equals
  full-index selection — selected IDs, reasons, changed symbols,
  unsafe reasons — over the selector and conformance suites plus a
  scripted mutation series on at least two examples.
- **AT-S03 (no whole-repo work):** with the fast path enabled,
  `vibehard test --dry-run` performs zero `createProgram` calls and
  zero worktree creations, and reads only changed/touched files
  (asserted via Phase 0 counters).
- **AT-S04 (selection budget):** on the generated `large` fixture
  (3,000 source files, 3,000 tests, K=150; Phase 0 baseline above),
  `vibehard test --dry-run` for a one-symbol change completes with a
  selection total ≤2 s excluding framework discovery on the CI
  runner, and ≤1 s with a warm parse cache.
- **AT-S05 (lockfile migration):** every committed v2 lockfile in
  the repo round-trips v2 → v3 → in-memory losslessly;
  `checkLockfile` and selection results are unchanged; migrated
  files are at least 5× smaller on the synthetic large case.
- **AT-S06 (parallel/sharded record):** `--jobs 4` and a 3-shard
  record each produce a lockfile identical to the serial record on
  all examples; merging shards with mismatched provenance fails.
- **AT-S07 (incremental record):** over a mutation series,
  incremental record followed by `verify --ci` reaches the same
  lockfile and verdict as full record followed by `verify --ci`;
  incremental record refuses when selection is unsafe.
- **AT-S08 (chunked delegation):** a selection larger than the argv
  budget runs via chunks with the same pass/fail result as the
  equivalent full run, and a `proveFilter` mismatch in any chunk
  falls back to a full run.
- **AT-S09 (support-file mapping):** editing a test helper selects
  exactly the specs importing it (transitively) in fixtures built
  for this; an unresolvable/dynamic helper import still forces a
  full run.

Existing acceptance tests keep passing throughout; in particular the
ground-truth selection audits (manifest AT-17/AT-19/AT-20) are the
recall guard for Phases 1, 3, and 5.

## Risks and mitigations

- **Parse-only extraction diverges from program-based extraction**
  (parent-node settings, script-kind inference, ambient/export
  assignment forms, files the program pulls in via imports but the
  `tsconfig` file list omits). Mitigation: AT-S01/AT-S02 parity over
  the full fixture corpus, opt-in rollout, automatic fallback to
  the current algorithm on inconsistency.
- **The "unchanged file ⇒ same hash at base" identity breaks** for
  generated or git-ignored source files that the diff never lists,
  or filter differences between revisions. Mitigation: apply the
  identity only to files tracked at the base and identically
  filtered at both sides; everything else is hashed explicitly or
  the run is unsafe.
- **Cache poisoning or staleness** in the Phase 1 symbol cache.
  Mitigation: content-hash keys including indexer and TypeScript
  versions; cache lives outside the repo; any parse/validation
  doubt discards the entry. The cache is an optimisation only —
  deleting it must never change results.
- **Partial-record merge semantics** could interleave entries from
  different source states in v3. Mitigation: intern (ID, hash)
  pairs (Phase 2) and shard provenance checks (Phase 3b) so mixed
  states are representable, detectable, and refused where they must
  agree.
- **Parallel recording interferes through the app** (shared test
  database, fixed ports in user code, singleton services).
  Mitigation: lanes are opt-in with `--jobs`, default 1; docs state
  the parallel-safety requirement; instability detection (record
  twice) remains per test within a lane and will surface
  interference as unstable sets rather than silently recording
  them.
- **Coverage deltas (3d) misattribute server execution** (script
  reloads resetting counts, ranges executed before the test
  window). Mitigation: 3d is a gated spike; delta-derived touched
  sets must equal restart-derived sets on all examples before
  enablement, with per-run fallback to restart on any snapshot
  anomaly.
- **Support-graph resolution misses an edge** (Phase 5), the one
  failure here that could hurt recall. Mitigation: the graph is
  built from a resolver allowlist of edge forms; anything else
  keeps today's full-run behaviour. Recall audits (AT-17) plus
  AT-S09 gate it.

## Open questions / decisions needed

- Performance budget numbers and the reference machine for AT-S04
  (CI runner vs developer laptop) — decide in Phase 0 from baseline
  measurements, not in advance.
- Lockfile v3 physical layout: decided at Phase 2 — single compact
  file (see "Phase 2 results"); revisit the per-spec directory only
  if merge pain is reported.
- CLI spellings for `--jobs`, `--shard`, and the merge command:
  decided at Phase 3 — `--jobs <n>`, `--shard <i>/<n>`,
  `--shard-out <file>`, `record --merge <files…>`, and
  `record --incremental` (see "Phase 3 results").
- Where shard artifacts live in CI (uploaded artifacts vs committed
  temporary files) — affects only docs/recipes, not the format.
- Whether discovery caching (Phase 4) is worth its invalidation
  surface once Phases 1–2 land; decide from Phase 0 profiles of
  `playwright test --list` at fixture scale.
- Whether `vibehard explain` should share the Phase 1 fast path in
  the same change (proposed: yes, it is the same code path in
  `packages/vibehard/src/selector/run.ts`).

## Alternatives considered and rejected

- **Full Rust rewrite now.** Solves a constant factor in code that
  is not the bottleneck, cannot move the adapters, and risks the
  type-checked reference graph. Deferred, with a defined revisit
  trigger (see "Would Rust help?").
- **Inverted index only.** Making the intersection O(changed
  symbols) saves at most a few hundred milliseconds at 10,000
  tests while two full TypeScript programs still run. Included in
  Phase 2 as hygiene, not as the fix.
- **Caching the full `indexProject` result as-is.** The expensive
  parts (program and checker construction) happen before the
  existing cache is consulted, and checker-derived references are
  cross-file, so a sound incremental cache for the full index is a
  build-system-sized project. The parse-only subset cache in
  Phase 1 gets the win where caching is trivially sound.
- **Heuristic or path-based pre-filtering** (e.g. only re-index
  "nearby" files, or skip trust checks for untouched areas without
  the diff-identity proof). Rejected outright: every shortcut must
  be a proof, not a guess, per the invariants above.
- **Approximate touched sets for very large suites** (sampling,
  dropping `referenced` edges). Rejected: degrades recall, which is
  the product.
