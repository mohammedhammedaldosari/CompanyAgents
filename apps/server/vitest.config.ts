import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: { alias: { '@agents/domain': path.resolve(__dirname, '../../packages/domain/src/index.ts') } },
  test: { testTimeout: 30_000, hookTimeout: 60_000, fileParallelism: false, env: { TZ: 'Asia/Riyadh' } }
});
