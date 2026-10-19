import { Cart } from "./lib/cart.js";
import { formatPrice } from "./lib/pricing.js";

const cart = new Cart();
cart.addItem({ sku: "pen", priceCents: 1299, quantity: 2 });
cart.addItem({ sku: "notebook", priceCents: 500, quantity: 1 });

const total = document.querySelector("#total");
if (total !== null) total.textContent = formatPrice(cart.totalCents());
