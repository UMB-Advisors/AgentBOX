import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'lib/**/*.test.ts'],
    testTimeout: 15_000,
    hookTimeout: 15_000,
    // Run test FILES serially. The DB-backed suites share one Postgres and
    // isolate via unique rows per test — except the forced-singleton
    // `mailbox.system_state` row (id=1, CHECK id=1). Multiple files mutate its
    // Gmail-cooldown columns (auto-send / drafts / gmail-cooldown suites), so
    // under parallel file execution one file's beforeEach NULLs the cooldown
    // while another has it armed mid-finalize → flaky cross-file race
    // (MBOX-16 SAFETY cooldown test). Serial files remove the race; the suite
    // is small enough that the wall-clock cost is negligible.
    fileParallelism: false,
  },
});
