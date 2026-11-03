import { defineConfig } from 'vitest/config';

// API tests only; infra/ has its own packages and runs its own tests (npm run check runs both).
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Some tests open a fresh database (every migration runs again); with all files in parallel that can take longer
    // than the defaults (5 s a test, 10 s a hook).
    env: { FIELD_KEY: 'test-field-key-0123456789abcdef' },
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
