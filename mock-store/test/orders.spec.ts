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
});
