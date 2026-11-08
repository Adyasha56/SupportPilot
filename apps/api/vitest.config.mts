import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

export default defineConfig({
  test: {
    // dev-scripts/**/*.spec.ts added specifically for mint-customer-token.spec.ts -
    // no other dev-scripts file has unit tests today, but this one's "Tests for
    // the pure parts" requirement needs somewhere that actually runs them; without
    // this, the tests would exist but never execute under `pnpm run test`/CI.
    include: ['src/**/*.spec.ts', 'test/**/*.e2e-spec.ts', 'dev-scripts/**/*.spec.ts'],
    expect: {
      requireAssertions: true,
    },
  },
  plugins: [swc.vite()],
});
