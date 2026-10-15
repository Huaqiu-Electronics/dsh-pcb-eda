import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/safety.live.integration.ts'], testTimeout: 150000 } });
