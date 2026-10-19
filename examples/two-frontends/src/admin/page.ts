import { adminSummary } from "./stats.js";

/** Render the admin page HTML (server-executed summary included). */
export function renderAdminPage(): string {
  return `<!doctype html>
<html><head><title>admin</title></head>
<body><main id="app">Admin</main>
<p id="admin-summary">${adminSummary()}</p>
<p id="admin-note"></p>
<script type="module" src="/admin-client.js"></script>
</body></html>`;
}
