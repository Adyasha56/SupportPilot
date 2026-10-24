import { Router } from 'express';
import { Clock } from '../clock';
import { OrderStore } from '../store/orders';
import { RefundStore } from '../store/refunds';

export function createRefundsRouter(orders: OrderStore, refunds: RefundStore, clock: Clock): Router {
  const router = Router();

  router.post('/', (req, res) => {
    const body = (req.body ?? {}) as { orderId?: unknown; amount?: unknown; idempotencyKey?: unknown };

    if (typeof body.orderId !== 'string' || typeof body.amount !== 'number') {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    const idempotencyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined;

    const order = orders.get(body.orderId);
    if (!order) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }

    const result = refunds.issue(body.orderId, body.amount, order, clock, idempotencyKey);

    switch (result.kind) {
      case 'created':
        orders.markRefunded(body.orderId);
        res.status(201).json(result.refund);
        return;
      case 'idempotent-replay':
        res.status(200).json(result.refund);
        return;
      case 'conflict':
        res.status(409).json({ error: result.reason });
        return;
      case 'invalid':
        res.status(400).json({ error: result.reason });
        return;
    }
  });

  return router;
}
