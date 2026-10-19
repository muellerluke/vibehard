import type { Request, Response } from "express";

import { findProduct, priceOrder } from "./catalog";

export function getProduct(req: Request, res: Response): void {
  const sku = typeof req.query["sku"] === "string" ? req.query["sku"] : "pen";
  const product = findProduct(sku);
  if (product === null) {
    res.status(404).json({ error: `unknown sku ${sku}` });
    return;
  }
  res.json(product);
}

export function createOrder(req: Request, res: Response): void {
  const body = (req.body ?? {}) as { sku?: string; quantity?: number };
  const product = findProduct(body.sku ?? "");
  if (product === null) {
    res.status(400).json({ error: "sku required and must exist" });
    return;
  }
  const totalCents = priceOrder(product.priceCents, body.quantity ?? 1);
  res.status(201).json({ sku: product.sku, totalCents });
}
