// Short-lived Node entry for the observer's server-only coverage test:
// runs Cart.addItem and formatPrice, then exits so NODE_V8_COVERAGE flushes.
import { Cart } from "../src/lib/cart.js";
import { formatPrice } from "../src/lib/format.js";

const cart = new Cart();
cart.addItem({ sku: "pen", priceCents: 1299, quantity: 1 });
process.stdout.write(`${formatPrice(1299)}\n`);
