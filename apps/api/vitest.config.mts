import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts', 'test/**/*.e2e-spec.ts'],
    expect: {
      requireAssertions: true,
    },
  },
  plugins: [swc.vite()],
});
