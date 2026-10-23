# Vibehard perf harness (Phase 0)

Contributor-only tooling for measuring selection and recording at
scale. It is not published with the package (`files` ships only
`dist`). Design and baseline results live in
[../../../SCALING.md](../../../SCALING.md).

## Running

From the repository root (builds first):

```bash
npm run perf -- --preset smoke
npm run perf -- --preset default
npm run perf -- --preset large --out /tmp/vh-perf-large.json
npm run perf -- --preset record-smoke
```

Selection presets generate a deterministic fixture repository, apply
a mutation scenario, run one excluded warm-up plus repeated
`vibehard test --dry-run --timing --json` invocations of the built
CLI, and print median/min/max wall and phase timings. The selected
tests are checked against the generator's ground truth on every run;
a mismatch fails the benchmark.

| Preset | Shape | Source files | Tests | Target touched/test |
|---|---|---|---|---|
| `smoke` | selection (Puppeteer) | 100 | 100 | 50 |
| `default` | selection (Puppeteer) | 1,000 | 1,000 | 100 |
| `large` | selection (Puppeteer) | 3,000 | 3,000 | 150 |
| `record-smoke` | recordable (Playwright) | 20 | 10 | observed |

Useful flags: `--scenario none|leaf|shared|spec` (default `leaf`),
`--repetitions N`, `--seed N`, `--out FILE` (JSON report), `--keep`
(retain the generated fixture for inspection), and generation
overrides such as `--files`, `--spec-files`, `--tests-per-spec`,
`--touched-per-test`.

Phase 1 (diff-proportional selection) is measured with
`--fast-select`, which passes the flag to every CLI run and fails
the benchmark if the fast path falls back to full indexing.
`--cold-cache` additionally deletes the fixture's parse cache
(`.git/vibehard-cache`) before every run, so repetitions measure
cold parses instead of warm cache hits:

```bash
npm run perf -- --preset large
npm run perf -- --preset large --fast-select
npm run perf -- --preset large --fast-select --cold-cache
```

`record-smoke` generates a small real app (esbuild harness with
source maps, Playwright specs that execute different generated
modules in browser and server) and runs one real
`vibehard record --timing`. It requires a Playwright Chromium
install. Phase 3 lanes are measured with `--jobs <n>` (the runner
fails if the record does not report that lane count):

```bash
npm run perf -- --preset record-smoke
npm run perf -- --preset record-smoke --jobs 4
```

`--no-timing` runs the built CLI without `--timing` and reports
external wall clock only. It exists to benchmark builds that
predate the timing flags (with this harness copied in as untracked
tooling) against current builds, as in the before/after table in
SCALING.md.

## How to read the output

- `setup` is fixture generation, including one full index used to
  build the synthetic lockfile. It is excluded from repetitions.
- `selection:*` phases come from `selectTests`; `test:*` phases are
  the `testProject` wrapper (its `selection` phase contains the
  `selection:*` detail).
- Fixture generation is deterministic per `--seed`; lockfile symbol
  IDs, hashes, config hash, and test IDs are produced by the real
  indexer and drivers, never hand-written.
- Numbers are medians over the repetitions on whatever machine ran
  them. Compare runs on the same machine; treat CI numbers as
  trends, not budgets.

Generated fixtures are created as `.vh-perf-*` directories at the
repository root (git-ignored) and deleted afterwards unless `--keep`
is passed.
