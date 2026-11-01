import { defineConfig } from 'vitest/config';

// API tests only; infra/ has its own packages and runs its own tests (npm run check runs both).
export default defineConfig({
  test: { include: ['test/**/*.test.ts'] },
});
