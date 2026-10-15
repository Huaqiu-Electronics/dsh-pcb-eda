import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Windows PID identity and exclusive-file probes spawn bounded PowerShell processes.
    testTimeout: 20_000,
    include: ['tests/**/*.integration.spec.ts'],
  },
});
