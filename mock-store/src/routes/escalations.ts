import { Router } from 'express';
import { Clock } from '../clock';
import { EscalationStore } from '../store/escalations';

export function createEscalationsRouter(escalations: EscalationStore, clock: Clock): Router {
  const router = Router();

  router.post('/', (req, res) => {
    const body = (req.body ?? {}) as { summary?: unknown };

    if (typeof body.summary !== 'string' || body.summary.trim().length === 0) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }

    const escalation = escalations.create(body.summary, clock);
    res.status(201).json(escalation);
  });

  return router;
}
