import { rm } from 'node:fs/promises';
// This fixed package-local output directory contains generated files only.
await rm(new URL('../lib/', import.meta.url), { recursive: true, force: true });
