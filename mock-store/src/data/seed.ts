import { Clock } from '../clock';

export interface Order {
  id: string;
  customerRef: string;
  status: 'delivered' | 'in_transit' | 'delayed' | 'cancelled' | 'refunded';
  total: number;
  placedAt: string;
  deliveredAt?: string;
}

export interface Shipment {
  orderId: string;
  trackingNumber: string;
  carrier: string;
  status: string;
  estimatedDelivery?: string;
}

export interface Refund {
  id: string;
  orderId: string;
  amount: number;
  status: 'refunded';
  idempotencyKey?: string;
  createdAt: string;
}

export interface SeedData {
  orders: Order[];
  shipments: Shipment[];
  refunds: Refund[];
}

function daysAgo(now: Date, days: number): string {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

/**
 * Nine seeded scenarios, keyed by order id:
 *  ORD-1001  normal delivered order
 *  ORD-1002  in-transit order
 *  ORD-1003  delayed order
 *  ORD-1004  delivered, outside a typical refund window (60 days ago)
 *  ORD-1005  already refunded
 *  ORD-1006  high-value, above a typical approval threshold
 *  ORD-1007  cancelled order
 *  ORD-1008  belongs to a different customer (ownership-check fixture)
 *  ORD-9999  deliberately NOT seeded — nonexistent order id
 */
export function buildSeedData(clock: Clock): SeedData {
  const now = clock();

  const orders: Order[] = [
    {
      id: 'ORD-1001',
      customerRef: 'cust_1',
      status: 'delivered',
      total: 49.99,
      placedAt: daysAgo(now, 5),
      deliveredAt: daysAgo(now, 3),
    },
    {
      id: 'ORD-1002',
      customerRef: 'cust_1',
      status: 'in_transit',
      total: 89.5,
      placedAt: daysAgo(now, 2),
    },
    {
      id: 'ORD-1003',
      customerRef: 'cust_2',
      status: 'delayed',
      total: 32.0,
      placedAt: daysAgo(now, 10),
    },
    {
      id: 'ORD-1004',
      customerRef: 'cust_2',
      status: 'delivered',
      total: 75.25,
      placedAt: daysAgo(now, 65),
      deliveredAt: daysAgo(now, 60),
    },
    {
      id: 'ORD-1005',
      customerRef: 'cust_3',
      status: 'refunded',
      total: 120.0,
      placedAt: daysAgo(now, 20),
      deliveredAt: daysAgo(now, 18),
    },
    {
      id: 'ORD-1006',
      customerRef: 'cust_3',
      status: 'delivered',
      total: 1249.0,
      placedAt: daysAgo(now, 7),
      deliveredAt: daysAgo(now, 4),
    },
    {
      id: 'ORD-1007',
      customerRef: 'cust_4',
      status: 'cancelled',
      total: 60.0,
      placedAt: daysAgo(now, 1),
    },
    {
      id: 'ORD-1008',
      customerRef: 'cust_5',
      status: 'delivered',
      total: 44.0,
      placedAt: daysAgo(now, 6),
      deliveredAt: daysAgo(now, 4),
    },
    // ORD-9999 intentionally not seeded.
  ];

  const shipments: Shipment[] = [
    {
      orderId: 'ORD-1001',
      trackingNumber: 'TRK-1001',
      carrier: 'AcmeShip',
      status: 'delivered',
      estimatedDelivery: daysAgo(now, 3),
    },
    {
      orderId: 'ORD-1002',
      trackingNumber: 'TRK-1002',
      carrier: 'AcmeShip',
      status: 'in_transit',
      // Still due in the future (negative daysAgo = days from now, not
      // days in the past) - placed 2 days ago, a normal shipping estimate
      // puts delivery a few days out still. In transit, not late, matches
      // the policy's "more than 7 calendar days past" late-delivery rule
      // (sample-policy.md) not even being reachable yet.
      estimatedDelivery: daysAgo(now, -3),
    },
    {
      orderId: 'ORD-1003',
      trackingNumber: 'TRK-1003',
      carrier: 'AcmeShip',
      status: 'delayed',
      // 8 calendar days past due - one day past sample-policy.md's "more
      // than 7 calendar days past its estimated delivery date" late
      // threshold, so this is the one seeded scenario that IS confirmed
      // late under the current policy wording (see docs/learning-notes.md's
      // Stage 9 consistency table).
      estimatedDelivery: daysAgo(now, 8),
    },
    {
      orderId: 'ORD-1004',
      trackingNumber: 'TRK-1004',
      carrier: 'AcmeShip',
      status: 'delivered',
      estimatedDelivery: daysAgo(now, 60),
    },
    {
      orderId: 'ORD-1005',
      trackingNumber: 'TRK-1005',
      carrier: 'AcmeShip',
      status: 'delivered',
      estimatedDelivery: daysAgo(now, 18),
    },
    {
      orderId: 'ORD-1006',
      trackingNumber: 'TRK-1006',
      carrier: 'AcmeShip',
      status: 'delivered',
      estimatedDelivery: daysAgo(now, 4),
    },
    {
      orderId: 'ORD-1008',
      trackingNumber: 'TRK-1008',
      carrier: 'AcmeShip',
      status: 'delivered',
      estimatedDelivery: daysAgo(now, 4),
    },
    // ORD-1007 was cancelled before shipping - no shipment record.
  ];

  const refunds: Refund[] = [
    {
      id: 'REF-9001',
      orderId: 'ORD-1005',
      amount: 120.0,
      status: 'refunded',
      createdAt: daysAgo(now, 15),
    },
  ];

  return { orders, shipments, refunds };
}
