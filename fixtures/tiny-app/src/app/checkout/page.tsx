import type { ReactElement } from "react";
import { formatPrice } from "../../lib/format.js";

export default function CheckoutPage(): ReactElement {
  return <main><h1>Checkout</h1><p>{formatPrice(1299)}</p></main>;
}
