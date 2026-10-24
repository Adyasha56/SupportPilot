import { Router } from 'express';
import { ShipmentStore } from '../store/shipments';

export function createShipmentsRouter(shipments: ShipmentStore): Router {
  const router = Router();

  router.get('/:orderId', (req, res) => {
    const shipment = shipments.get(req.params.orderId);
    if (!shipment) {
      res.status(404).json({ error: 'Shipment not found' });
      return;
    }
    res.status(200).json(shipment);
  });

  return router;
}
