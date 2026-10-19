export function formatPrice(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export function applyDiscount(cents: number, percentOff: number): number {
  return Math.round(cents * (1 - percentOff / 100));
}
