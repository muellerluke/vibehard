import { formatPrice } from "../shared/pricing.js";
import { PRODUCTS, storeTotalCents } from "./catalog.js";

/** Browser-executed store code. */
export function bootStore(): void {
  const count = document.querySelector("#store-count");
  if (count !== null) {
    count.textContent = `${PRODUCTS.length} products, ${formatPrice(storeTotalCents())}`;
  }
}

bootStore();
