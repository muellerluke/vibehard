// Stage 2 harness server. Deliberately OUTSIDE `src/` so the indexer
// (tsconfig include: ["src"]) still sees exactly the AT-02 ground truth.
// Bundled by the observer tests with esbuild; never run from source.
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

import { POST } from "../src/app/api/coupons/route.js";
import CheckoutPage from "../src/app/checkout/page.js";

const port = Number(process.env["TINY_APP_PORT"] ?? "4173");
const clientBundle = process.env["TINY_APP_CLIENT_BUNDLE"] ?? "";

const page = `<!doctype html>
<html><head><title>tiny-app checkout</title></head>
<body><main id="app">Checkout</main><p id="price"></p>
<script type="module" src="/client.js"></script>
</body></html>`;

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/") {
      // Invoking the component executes CheckoutPage (and formatPrice)
      // on the server; no DOM renderer is needed for coverage purposes.
      void CheckoutPage();
      res.writeHead(200, { "content-type": "text/html" });
      res.end(page);
      return;
    }
    if (req.method === "GET" && req.url === "/client.js") {
      const body = await readFile(clientBundle, "utf8");
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end(body);
      return;
    }
    if (req.method === "POST" && req.url === "/api/coupons") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const request = new Request(`http://127.0.0.1:${port}/api/coupons`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: Buffer.concat(chunks).toString("utf8"),
      });
      const response = await POST(request);
      res.writeHead(response.status, {
        "content-type": response.headers.get("content-type") ?? "application/json",
      });
      res.end(await response.text());
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  } catch (error) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(String(error));
  }
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`tiny-app harness listening on ${port}\n`);
});

// NODE_V8_COVERAGE flushes on Node's normal exit path; exit through it.
process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});
