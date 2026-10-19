export const formatPrice = (cents: number): string => {
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(cents);
  return `${sign}$${(absolute / 100).toFixed(2)}`;
};

export function applyDiscount(cents: number, percentOff: number): number {
  const clamped = Math.min(90, Math.max(0, percentOff));
  return Math.round(cents * (1 - clamped / 100));
}
