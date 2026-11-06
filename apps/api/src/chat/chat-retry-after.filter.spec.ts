import { describe, expect, it } from 'vitest';
import { Controller, INestApplication, Post, UseFilters } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { chatHttpError } from './chat-http-error';
import { ChatRetryAfterFilter } from './chat-retry-after.filter';

@Controller('test')
@UseFilters(ChatRetryAfterFilter)
class TestController {
  @Post('rate-limited')
  rateLimited(): never {
    throw chatHttpError('RATE_LIMITED', 'slow down', 30);
  }

  @Post('busy')
  busy(): never {
    throw chatHttpError('CONVERSATION_BUSY', 'busy', 2);
  }

  @Post('invalid')
  invalid(): never {
    throw chatHttpError('INVALID_REQUEST', 'bad input');
  }
}

describe('ChatRetryAfterFilter', () => {
  it('sets the Retry-After header from the body\'s retryAfterSeconds on a 429', async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [TestController] }).compile();
    const app: INestApplication = moduleRef.createNestApplication();
    await app.init();

    const res = await request(app.getHttpServer()).post('/test/rate-limited').send({});

    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('30');
    expect(res.body).toEqual({ statusCode: 429, code: 'RATE_LIMITED', message: 'slow down', retryAfterSeconds: 30 });
    await app.close();
  });

  it('sets the Retry-After header on a 409 too, when the body carries one', async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [TestController] }).compile();
    const app: INestApplication = moduleRef.createNestApplication();
    await app.init();

    const res = await request(app.getHttpServer()).post('/test/busy').send({});

    expect(res.status).toBe(409);
    expect(res.headers['retry-after']).toBe('2');
    await app.close();
  });

  it('never sets Retry-After when the body has no such field', async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [TestController] }).compile();
    const app: INestApplication = moduleRef.createNestApplication();
    await app.init();

    const res = await request(app.getHttpServer()).post('/test/invalid').send({});

    expect(res.status).toBe(400);
    expect(res.headers['retry-after']).toBeUndefined();
    await app.close();
  });
});
