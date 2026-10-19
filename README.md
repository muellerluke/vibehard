# vibehard

Exact e2e test selection via declared, machine-verified symbol mapping.
See [MANIFEST.md](MANIFEST.md) for the product spec and staged build plan.

Status: Stage 4 — change selection and `vibehard test` (Playwright).
`record`, `verify`, `test`, and `explain` work; `init` lands in Stage 5.

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

With a `vibehard.config.json` at the project root (see
`fixtures/tiny-app/` for a complete example):

```bash
vibehard record   # generate/repair declarations from real runs
vibehard verify   # fail on any missing/extra symbol or lockfile drift
vibehard test     # run only the tests affected by your change
```

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
