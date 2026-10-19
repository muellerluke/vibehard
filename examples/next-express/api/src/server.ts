import express from "express";

import { createOrder, getProduct } from "./routes";

const port = Number(process.env["API_PORT"] ?? "4100");

const app = express();
app.use(express.json());
app.get("/api/products", getProduct);
app.post("/api/orders", createOrder);

const server = app.listen(port, "127.0.0.1", () => {
  process.stdout.write(`next-express api listening on ${port}\n`);
});

// NODE_V8_COVERAGE flushes on Node's normal exit path; exit through it.
process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});
