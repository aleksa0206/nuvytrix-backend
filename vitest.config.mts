import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['tests/helpers/setupEnv.ts'],
    // Integration tests share one database; running files in parallel would let them truncate each other's rows.
    fileParallelism: false,
  },
});
