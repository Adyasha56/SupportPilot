import { Shipment } from '../data/seed';

export class ShipmentStore {
  private readonly shipments: Map<string, Shipment>;

  constructor(list: Shipment[]) {
    this.shipments = new Map(list.map((shipment) => [shipment.orderId, shipment]));
  }

  get(orderId: string): Shipment | undefined {
    return this.shipments.get(orderId);
  }
}
