import { defineConfig } from "cypress";
import { registerVibehardTasks } from "vibehard/cypress/node";

// The app server is started by vibehard (see vibehard.config.json),
// which exports VIBEHARD_BASE_URL. For a plain `cypress run`, build and
// start the app yourself (`npm run build && npm run start`) first.
export default defineConfig({
  e2e: {
    baseUrl: process.env["VIBEHARD_BASE_URL"] ?? "http://127.0.0.1:3000",
    specPattern: "cypress/e2e/**/*.cy.js",
    supportFile: "cypress/support/e2e.js",
    video: false,
    setupNodeEvents(on) {
      registerVibehardTasks(on);
    },
  },
});
