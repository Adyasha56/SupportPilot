import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestApp, authHeader } from './helpers';

describe('GET /orders/:id', () => {
  it('returns 401 without a token', async () => {
    const res = await request(createTestApp()).get('/orders/ORD-1001');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
  });

  it('returns 401 with the wrong token', async () => {
    const res = await request(createTestApp())
      .get('/orders/ORD-1001')
      .set('Authorization', authHeader('wrong-token'));
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
  });

  it('returns the seeded order', async () => {
    const res = await request(createTestApp())
      .get('/orders/ORD-1001')
      .set('Authorization', authHeader());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: 'ORD-1001',
      customerRef: 'cust_1',
      status: 'delivered',
      total: 49.99,
    });
  });

  it('returns 404 for a nonexistent order', async () => {
    const res = await request(createTestApp())
      .get('/orders/ORD-9999')
      .set('Authorization', authHeader());
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Order not found' });
  });

  it('reports alreadyRefundedTotal as 0 for an order that has never been refunded', async () => {
    const res = await request(createTestApp())
      .get('/orders/ORD-1001')
      .set('Authorization', authHeader());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ alreadyRefundedTotal: 0 });
  });

  it('reports alreadyRefundedTotal joined from the refund record, for a pre-seeded already-refunded order', async () => {
    const res = await request(createTestApp())
      .get('/orders/ORD-1005')
      .set('Authorization', authHeader());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'refunded', total: 120.0, alreadyRefundedTotal: 120.0 });
  });

  it('reports alreadyRefundedTotal reflecting a refund issued during this test run', async () => {
    const app = createTestApp();
    await request(app)
      .post('/refunds')
      .set('Authorization', authHeader())
      .send({ orderId: 'ORD-1002', amount: 50 });

    const res = await request(app).get('/orders/ORD-1002').set('Authorization', authHeader());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ alreadyRefundedTotal: 50 });
  });
});
