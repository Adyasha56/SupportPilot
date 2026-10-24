import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestApp, authHeader } from './helpers';

describe('POST /refunds', () => {
  it('returns 401 without a token', async () => {
    const res = await request(createTestApp())
      .post('/refunds')
      .send({ orderId: 'ORD-1001', amount: 10 });
    expect(res.status).toBe(401);
  });

  it('issues a refund for a valid order and amount', async () => {
    const res = await request(createTestApp())
      .post('/refunds')
      .set('Authorization', authHeader())
      .send({ orderId: 'ORD-1001', amount: 49.99 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ orderId: 'ORD-1001', amount: 49.99, status: 'refunded' });
    expect(res.body.id).toMatch(/^REF-/);
  });

  it('returns 404 for a nonexistent order', async () => {
    const res = await request(createTestApp())
      .post('/refunds')
      .set('Authorization', authHeader())
      .send({ orderId: 'ORD-9999', amount: 10 });
    expect(res.status).toBe(404);
  });

  it('returns 409 when refunding an order that was already refunded', async () => {
    const res = await request(createTestApp())
      .post('/refunds')
      .set('Authorization', authHeader())
      .send({ orderId: 'ORD-1005', amount: 120.0 });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already been refunded/);
  });

  it('returns 409 when a second, different refund is attempted on the same order within one session', async () => {
    const app = createTestApp();
    const first = await request(app)
      .post('/refunds')
      .set('Authorization', authHeader())
      .send({ orderId: 'ORD-1001', amount: 49.99 });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post('/refunds')
      .set('Authorization', authHeader())
      .send({ orderId: 'ORD-1001', amount: 49.99 });
    expect(second.status).toBe(409);
  });

  it('returns 400 when the amount exceeds the order total', async () => {
    const res = await request(createTestApp())
      .post('/refunds')
      .set('Authorization', authHeader())
      .send({ orderId: 'ORD-1001', amount: 999 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/exceeds the order total/);
  });

  it('replays the original result for a repeated idempotencyKey with the same body', async () => {
    const app = createTestApp();
    const first = await request(app)
      .post('/refunds')
      .set('Authorization', authHeader())
      .send({ orderId: 'ORD-1001', amount: 49.99, idempotencyKey: 'retry-1' });
    expect(first.status).toBe(201);

    const replay = await request(app)
      .post('/refunds')
      .set('Authorization', authHeader())
      .send({ orderId: 'ORD-1001', amount: 49.99, idempotencyKey: 'retry-1' });
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(first.body.id);
    expect(replay.body.status).toBe('refunded');
  });

  it('returns 409 when the same idempotencyKey is reused with a different amount', async () => {
    const app = createTestApp();
    await request(app)
      .post('/refunds')
      .set('Authorization', authHeader())
      .send({ orderId: 'ORD-1001', amount: 49.99, idempotencyKey: 'retry-2' });

    const res = await request(app)
      .post('/refunds')
      .set('Authorization', authHeader())
      .send({ orderId: 'ORD-1001', amount: 10, idempotencyKey: 'retry-2' });
    expect(res.status).toBe(409);
  });

  it('returns 409 when the same idempotencyKey is reused with a different order', async () => {
    const app = createTestApp();
    await request(app)
      .post('/refunds')
      .set('Authorization', authHeader())
      .send({ orderId: 'ORD-1001', amount: 49.99, idempotencyKey: 'retry-3' });

    const res = await request(app)
      .post('/refunds')
      .set('Authorization', authHeader())
      .send({ orderId: 'ORD-1002', amount: 49.99, idempotencyKey: 'retry-3' });
    expect(res.status).toBe(409);
  });
});
