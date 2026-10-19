# next-cypress example

Next.js (App Router, same app shape as `examples/next-fullstack`)
tested with Cypress and Vibehard wired through the
instrumented-coverage path. Declarations in `cypress/e2e/app.cy.js`
and `vibehard.lock.json` were produced by `vibehard record` and verify
green.

```bash
# from the repo root, with the workspace installed and vibehard built:
npm run build -w next-cypress

# from this directory:
node ../../packages/vibehard/dist/cli.js verify
node ../../packages/vibehard/dist/cli.js test --dry-run
```

How coverage works here (Cypress has no V8 range API):

- **Client symbols** come from Istanbul: `.babelrc` adds
  `babel-plugin-istanbul` under `BABEL_ENV=cypress`, and `npm run
  build` runs `next build --webpack` with that env. The build emits
  instrumented code whose `window.__coverage__` the support file
  snapshots per test. A page that runs without `__coverage__` fails
  verification closed.
- **Server symbols** still come from Node V8 coverage of the
  production server Vibehard starts (`start-server.mjs`), remapped
  through source maps. Webpack production builds emit no server maps,
  so `next.config.mjs` forces `devtool: "source-map"` for the server
  bundle.
- The babel preset pins modern targets (node 20 / chrome >= 111):
  without them `next/babel` downlevels async functions to regenerator
  helpers that Server Actions reject.
- Tested routes render per request (`force-dynamic`); prerendered
  routes execute at build time and cannot be observed.
- Wiring: `registerVibehardSupport()` in `cypress/support/e2e.js`,
  `registerVibehardTasks(on)` in `cypress.config.mjs`
  `setupNodeEvents`. Specs need no vibehard code; `vibehard record`
  maps what each test touches. Plain `cypress run` is unaffected.
