import { formatPrice } from "./lib/pricing.js";

/** Render the home page HTML (server-executed seed price included). */
export function renderHome(seedCents: number): string {
  return `<!doctype html>
<html><head><title>plain-puppeteer shop</title></head>
<body><main id="app">Shop</main>
<p id="seed">${formatPrice(seedCents)}</p>
<p id="total"></p>
<script type="module" src="/client.js"></script>
</body></html>`;
}
