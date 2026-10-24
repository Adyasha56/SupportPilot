import { Order } from '../data/seed';

export class OrderStore {
  private readonly orders: Map<string, Order>;

  constructor(list: Order[]) {
    this.orders = new Map(list.map((order) => [order.id, order]));
  }

  get(id: string): Order | undefined {
    return this.orders.get(id);
  }

  markRefunded(id: string): void {
    const order = this.orders.get(id);
    if (order) {
      order.status = 'refunded';
    }
  }
}
