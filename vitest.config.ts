import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    env: { TZ: 'Europe/Berlin' },
    include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs', 'mcp/**/*.test.ts', 'testkit/**/*.test.mjs'],
    // A node:test file, run by ci.yml's `changes` job (`node --test scripts/ci-affected.test.mjs`), not by Vitest.
    exclude: ['**/node_modules/**', 'scripts/ci-affected.test.mjs'],
  },
});
