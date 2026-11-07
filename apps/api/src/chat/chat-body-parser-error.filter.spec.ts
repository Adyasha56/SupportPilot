import { describe, expect, it } from 'vitest';
import { Controller, INestApplication, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ChatBodyParserErrorFilter } from './chat-body-parser-error.filter';

@Controller('other')
class OtherController {
  @Post()
  handle(): string {
    return 'ok';
  }
}

async function buildApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ controllers: [OtherController] }).compile();
  const app: INestApplication = moduleRef.createNestApplication();
  app.useGlobalFilters(new ChatBodyParserErrorFilter(app.getHttpAdapter()));
  await app.init();
  return app;
}

describe('ChatBodyParserErrorFilter', () => {
  it('leaves every other route\'s body-parser error handling untouched (delegates to super.catch())', async () => {
    const app = await buildApp();

    const oversized = await request(app.getHttpServer()).post('/other').send({ message: 'x'.repeat(200_000) });
    expect(oversized.status).toBe(413);
    expect(oversized.body).not.toHaveProperty('code'); // Nest's own default shape, unchanged

    const malformed = await request(app.getHttpServer()).post('/other').set('Content-Type', 'application/json').send('{not valid');
    expect(malformed.status).toBe(400);
    expect(malformed.body).not.toHaveProperty('code'); // Nest's own default BadRequestException shape, unchanged

    await app.close();
  });

  it('a normal request to a non-chat route still succeeds (the filter is a no-op on the happy path)', async () => {
    const app = await buildApp();

    const res = await request(app.getHttpServer()).post('/other').send({});

    expect(res.status).toBe(201);
    expect(res.text).toBe('ok');

    await app.close();
  });
});
