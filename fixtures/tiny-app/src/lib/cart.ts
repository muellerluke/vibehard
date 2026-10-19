export interface CartItem {
  sku: string;
  priceCents: number;
  quantity: number;
}

export class Cart {
  readonly items: CartItem[] = [];

  addItem(item: CartItem): void {
    const existing = this.items.find((i) => i.sku === item.sku);
    if (existing) {
      existing.quantity += item.quantity;
    } else {
      this.items.push(item);
    }
  }
}
