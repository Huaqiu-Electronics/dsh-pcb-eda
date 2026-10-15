import { fileURLToPath } from 'node:url';
import { verifyBuildInputs } from './build-inputs.mjs';

await verifyBuildInputs(fileURLToPath(new URL('..', import.meta.url)));
