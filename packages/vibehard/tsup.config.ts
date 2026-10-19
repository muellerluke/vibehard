import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    cli: "src/cli/index.ts",
    playwright: "src/adapters/playwright/index.ts",
    puppeteer: "src/adapters/puppeteer/index.ts",
    cypress: "src/adapters/cypress/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node20",
});
