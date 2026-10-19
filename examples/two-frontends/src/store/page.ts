import { formatPrice } from "../shared/pricing.js";
import { storeTotalCents } from "./catalog.js";

/** Render the store page HTML (server-executed total included). */
export function renderStorePage(): string {
  return `<!doctype html>
<html><head><title>store</title></head>
<body><main id="app">Store</main>
<p id="store-total">${formatPrice(storeTotalCents())}</p>
<p id="store-count"></p>
<script type="module" src="/store-client.js"></script>
</body></html>`;
}
