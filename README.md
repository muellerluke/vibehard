# vibehard

Exact e2e test selection via declared, machine-verified symbol mapping.
See [MANIFEST.md](MANIFEST.md) for the product spec and staged build plan.

Status: Stage 3 — declaration API and verifier (Playwright). `vibehard
record` and `vibehard verify` work; `init`, `test`, and `explain` land in
later stages.

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
```

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
