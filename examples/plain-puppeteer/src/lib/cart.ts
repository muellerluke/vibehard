export interface CartItem {
  sku: string;
  priceCents: number;
  quantity: number;
}

export class Cart {
  readonly items: CartItem[] = [];

  addItem(item: CartItem): void {
    const existing = this.items.find((i) => i.sku === item.sku);
    if (existing !== undefined) existing.quantity += item.quantity;
    else this.items.push({ ...item });
  }

  totalCents(): number {
    return this.items.reduce((sum, i) => sum + i.priceCents * i.quantity, 0);
  }
}
