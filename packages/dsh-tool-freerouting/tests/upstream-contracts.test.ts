import { expect, it } from 'vitest';
import { parseJobStatus, parseJobOutput, parseIdentifier } from '../src/proxy/upstream-contracts.js';

it('requires the pinned engine state and rejects obsolete or conflicting aliases', () => {
  expect(parseJobStatus({ state: 'QUEUED', stage: 'IDLE' }).state).toBe('QUEUED');
  expect(parseJobStatus({ state: 'STOPPING' }).state).toBe('STOPPING');
  for (const value of [{}, { status: 'COMPLETED' }, { state: 'UNKNOWN' }, { state: 'RUNNING', status: 'COMPLETED' }]) {
    expect(() => parseJobStatus(value)).toThrow(expect.objectContaining({ code: 'FREEROUTING_PROTOCOL_FAILED' }));
  }
});

it('accepts only the bundled engine data field for session output', () => {
  expect(parseJobOutput({ data: 'c2Vz', filename: 'board.ses' }).data).toBe('c2Vz');
  for (const value of [{}, { dataBase64: 'c2Vz' }, { output: 'c2Vz' }, { ses: 'c2Vz' }, { data: 42 }]) {
    expect(() => parseJobOutput(value)).toThrow(expect.objectContaining({ code: 'FREEROUTING_PROTOCOL_FAILED' }));
  }
});

it('uses the pinned engine id field for created sessions and jobs without guessing aliases', () => {
  expect(parseIdentifier({ id: 'engine-id' }).id).toBe('engine-id');
  for (const value of [{}, { id: '' }, { id: 1 }, { job_id: 'job' }, { session_id: 'session' }]) {
    expect(() => parseIdentifier(value)).toThrow(expect.objectContaining({ code: 'FREEROUTING_PROTOCOL_FAILED' }));
  }
});
