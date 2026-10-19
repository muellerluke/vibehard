import { defineConfig } from "@playwright/test";

// The app server is started by vibehard (see vibehard.config.json), which
// exports VIBEHARD_BASE_URL. For a plain `playwright test` run, build and
// start the app yourself (`npm run build && npm run start`) first.
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  use: {
    baseURL: process.env["VIBEHARD_BASE_URL"] ?? "http://127.0.0.1:3000",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
