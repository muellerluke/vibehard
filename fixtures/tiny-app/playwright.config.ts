import { defineConfig } from "@playwright/test";

// The app server is started by vibehard (see vibehard.config.json), which
// exports VIBEHARD_BASE_URL. For a plain `playwright test` run, start the
// harness yourself on the default port first.
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  use: {
    baseURL: process.env["VIBEHARD_BASE_URL"] ?? "http://127.0.0.1:4173",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
