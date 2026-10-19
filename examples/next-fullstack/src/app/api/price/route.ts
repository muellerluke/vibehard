import { applyDiscount, formatPrice } from "../../../lib/pricing";

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const cents = Number(params.get("cents") ?? "10000");
  const discount = Number(params.get("discount") ?? "0");
  const total = applyDiscount(cents, discount);
  return Response.json({ cents: total, formatted: formatPrice(total) });
}
