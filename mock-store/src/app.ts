import express, { Express, NextFunction, Request, Response } from 'express';
import { Clock, systemClock } from './clock';
import { buildSeedData } from './data/seed';
import { createAuthMiddleware } from './middleware/auth';
import { OrderStore } from './store/orders';
import { ShipmentStore } from './store/shipments';
import { RefundStore } from './store/refunds';
import { EscalationStore } from './store/escalations';
import { createOrdersRouter } from './routes/orders';
import { createShipmentsRouter } from './routes/shipments';
import { createRefundsRouter } from './routes/refunds';
import { createEscalationsRouter } from './routes/escalations';

export interface CreateAppOptions {
  clock?: Clock;
  token?: string;
}

/**
 * Builds a fresh Express app with fresh in-memory state every call - no
 * module-level mutable state, so each test (or each real process) gets an
 * isolated store.
 */
export function createApp(options: CreateAppOptions = {}): Express {
  const clock = options.clock ?? systemClock;
  const token = options.token ?? process.env.MOCK_STORE_TOKEN ?? 'dev-token';

  const seed = buildSeedData(clock);
  const orders = new OrderStore(seed.orders);
  const shipments = new ShipmentStore(seed.shipments);
  const refunds = new RefundStore(seed.refunds);
  const escalations = new EscalationStore();

  const app = express();
  app.use(express.json({ limit: '100kb' }));
  app.use(createAuthMiddleware(token));
  app.use('/orders', createOrdersRouter(orders, refunds));
  app.use('/shipments', createShipmentsRouter(shipments));
  app.use('/refunds', createRefundsRouter(orders, refunds, clock));
  app.use('/escalations', createEscalationsRouter(escalations, clock));

  // Generic by design: never echoes the parse error, the offending body, or
  // a stack trace. Body-parser errors (malformed JSON, oversized payload)
  // carry their own status; anything else falls back to 500.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = isHttpError(err) ? err.status : 500;
    const message = status === 400 || status === 413 ? 'Invalid request body' : 'Internal error';
    res.status(status).json({ error: message });
  });

  return app;
}

function isHttpError(err: unknown): err is { status: number } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    typeof (err as { status: unknown }).status === 'number'
  );
}
