import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import { renderStorePage } from "./page.js";

const port = Number(process.env["PORT"] ?? "4175");
const clientBundle = process.env["STORE_CLIENT_BUNDLE"] ?? ".build/store-client.mjs";

async function routeStoreRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(renderStorePage());
    return;
  }
  if (req.method === "GET" && url.pathname === "/store-client.js") {
    const body = await readFile(clientBundle, "utf8");
    res.writeHead(200, { "content-type": "text/javascript" });
    res.end(body);
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
}

const server = createServer((req, res) => {
  routeStoreRequest(req, res).catch(() => {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("error");
  });
});
server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
