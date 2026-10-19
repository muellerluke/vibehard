import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import { priceHandler } from "./api.js";
import { renderHome } from "./page.js";

const port = Number(process.env["PORT"] ?? "4174");
const clientBundle = process.env["CLIENT_BUNDLE"] ?? ".build/client.mjs";

async function routeRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  if (req.method === "GET" && url.pathname === "/") {
    const seed = Number(url.searchParams.get("cents") ?? "1299");
    res.writeHead(200, { "content-type": "text/html" });
    res.end(renderHome(seed));
    return;
  }
  if (req.method === "GET" && url.pathname === "/client.js") {
    const body = await readFile(clientBundle, "utf8");
    res.writeHead(200, { "content-type": "text/javascript" });
    res.end(body);
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/price") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(priceHandler(url)));
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
}

const server = createServer((req, res) => {
  routeRequest(req, res).catch(() => {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("error");
  });
});
server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
