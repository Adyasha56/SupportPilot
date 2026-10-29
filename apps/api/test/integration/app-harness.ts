/**
 * Boots the REAL AppModule (real Mongoose repositories, real
 * TransactionRunner, real ApiKeyGuard) for integration tests, exactly as
 * main.ts does, with exactly one override: LLM_PROVIDER -> FakeLlmProvider,
 * so no real Gemini quota is spent and no data leaves the machine. Nothing
 * else is faked - the point of this suite is to exercise the real wiring,
 * not a second, separate code path (see RULES.md: "the same agent engine
 * serves real chats and evaluation runs" - the same principle applies here
 * to tests).
 *
 * import './test-env' must run before AppModule is imported (it sets
 * process.env.MONGODB_URI from MONGODB_TEST_URI) - done via vitest's
 * setupFiles, which always runs before a spec file's own imports resolve.
 */
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { LLM_PROVIDER } from '../../src/llm/llm.module';
import { FakeLlmProvider } from '../../src/llm/test-utils/fake-llm-provider';

export interface AppHarness {
  app: INestApplication;
  close(): Promise<void>;
}

export async function bootApp(): Promise<AppHarness> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(LLM_PROVIDER)
    .useClass(FakeLlmProvider)
    .compile();

  const app = moduleRef.createNestApplication();
  await app.init();

  return {
    app,
    close: () => app.close(),
  };
}
