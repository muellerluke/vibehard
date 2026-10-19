// Stage 2 harness client entry. Exercises exactly Cart.addItem and
// formatPrice in the browser; it never calls the coupon route, so POST
// stays out of the AT-05 page-load ground truth.
import { Cart } from "../src/lib/cart.js";
import { formatPrice } from "../src/lib/format.js";

const cart = new Cart();
cart.addItem({ sku: "pen", priceCents: 1299, quantity: 1 });
cart.addItem({ sku: "pen", priceCents: 1299, quantity: 2 });
cart.addItem({ sku: "notebook", priceCents: 500, quantity: 1 });

const total = cart.items.reduce((sum, i) => sum + i.priceCents * i.quantity, 0);
const price = document.querySelector("#price");
if (price !== null) price.textContent = formatPrice(total);
document.documentElement.dataset["tinyAppReady"] = formatPrice(total);
