import { defineConfig } from "@playwright/test";

// Both frontends are started by vibehard (see vibehard.config.json),
// which exports VIBEHARD_BASE_URL (the store, the `app` entry) and
// VIBEHARD_ADMIN_URL (the admin `servers` entry). For a plain
// `playwright test` run, start `.build/store-server.mjs` on PORT=4175
// and `.build/admin-server.mjs` on PORT=4176 yourself first.
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  use: {
    baseURL: process.env["VIBEHARD_BASE_URL"] ?? "http://127.0.0.1:4175",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
