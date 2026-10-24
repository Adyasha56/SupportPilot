import { describe, expect, it } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

describe('HealthController', () => {
  it('returns the status produced by the injected HealthService', async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [HealthService],
    }).compile();

    const controller = module.get(HealthController);

    expect(controller.check()).toEqual({ status: 'ok' });
  });
});
