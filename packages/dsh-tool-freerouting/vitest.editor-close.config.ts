import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/editor-close.live.integration.ts'], testTimeout: 120000 } });
