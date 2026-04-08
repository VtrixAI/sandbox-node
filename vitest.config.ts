import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./tests/setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    reporters: ['verbose'],
  },
});
