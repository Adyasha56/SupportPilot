import { Router } from 'express';
import { OrderStore } from '../store/orders';
import { RefundStore } from '../store/refunds';

export function createOrdersRouter(orders: OrderStore, refunds: RefundStore): Router {
  const router = Router();

  router.get('/:id', (req, res) => {
    const order = orders.get(req.params.id);
    if (!order) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }
    // Joined from RefundStore at response time, never duplicated onto the
    // Order record itself - RefundStore stays the one source of truth for
    // "how much has been refunded." 0 when nothing has been refunded yet.
    const alreadyRefundedTotal = refunds.getByOrder(order.id)?.amount ?? 0;
    res.status(200).json({ ...order, alreadyRefundedTotal });
  });

  return router;
}
