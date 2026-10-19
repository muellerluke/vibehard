import { formatPrice } from "../shared/pricing.js";

export const REVENUE_CENTS = 42_500;

/** Admin-only: editing this must not select store-only tests. */
export function adminSummary(): string {
  return `revenue ${formatPrice(REVENUE_CENTS)}`;
}
