import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/ipc-live.integration.ts'], testTimeout: 120000 } });
