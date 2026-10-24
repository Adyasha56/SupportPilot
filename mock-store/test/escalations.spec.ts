import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestApp, authHeader } from './helpers';

describe('POST /escalations', () => {
  it('returns 401 without a token', async () => {
    const res = await request(createTestApp())
      .post('/escalations')
      .send({ summary: 'customer is upset' });
    expect(res.status).toBe(401);
  });

  it('creates an escalation', async () => {
    const res = await request(createTestApp())
      .post('/escalations')
      .set('Authorization', authHeader())
      .send({ summary: 'customer is upset' });
    expect(res.status).toBe(201);
    expect(res.body.id).toMatch(/^ESC-/);
    expect(res.body.summary).toBe('customer is upset');
    expect(res.body.status).toBe('created');
  });

  it('returns 400 for a missing summary', async () => {
    const res = await request(createTestApp())
      .post('/escalations')
      .set('Authorization', authHeader())
      .send({});
    expect(res.status).toBe(400);
  });
});
