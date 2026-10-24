import { Router } from 'express';
import { OrderStore } from '../store/orders';

export function createOrdersRouter(orders: OrderStore): Router {
  const router = Router();

  router.get('/:id', (req, res) => {
    const order = orders.get(req.params.id);
    if (!order) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }
    res.status(200).json(order);
  });

  return router;
}
