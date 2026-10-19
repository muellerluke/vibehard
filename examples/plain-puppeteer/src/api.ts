import { applyDiscount, formatPrice } from "./lib/pricing.js";

/** Price API: GET /api/price?cents=10000&discount=25 → discounted total. */
export function priceHandler(url: URL): { cents: number; formatted: string } {
  const cents = Number(url.searchParams.get("cents") ?? "0");
  const discount = Number(url.searchParams.get("discount") ?? "0");
  const finalCents = discount > 0 ? applyDiscount(cents, discount) : cents;
  return { cents: finalCents, formatted: formatPrice(finalCents) };
}
