import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestApp, authHeader } from './helpers';

describe('GET /shipments/:orderId', () => {
  it('returns 401 without a token', async () => {
    const res = await request(createTestApp()).get('/shipments/ORD-1002');
    expect(res.status).toBe(401);
  });

  it('returns the seeded shipment', async () => {
    const res = await request(createTestApp())
      .get('/shipments/ORD-1002')
      .set('Authorization', authHeader());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ orderId: 'ORD-1002', status: 'in_transit' });
  });

  it('returns 404 for an order with no shipment record', async () => {
    const res = await request(createTestApp())
      .get('/shipments/ORD-1007')
      .set('Authorization', authHeader());
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Shipment not found' });
  });

  it('returns 404 for a nonexistent order', async () => {
    const res = await request(createTestApp())
      .get('/shipments/ORD-9999')
      .set('Authorization', authHeader());
    expect(res.status).toBe(404);
  });
});
