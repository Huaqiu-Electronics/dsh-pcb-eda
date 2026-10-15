import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateEngineBuild } from '../build-inputs.mjs';

const source = { version: '2.5.0', patch_sources: { 'SesWriter.java': 'fixed-source' } };
const provenance = { source, upstream_tests_passed: true, output_sha256: 'built-jar' };

test('accepts a source-matching, checked engine build', () => {
  validateEngineBuild(provenance, source, 'built-jar');
});

test('rejects a JAR changed after the successful source build', () => {
  assert.throws(() => validateEngineBuild(provenance, source, 'different-jar'), /corrupt/);
});

test('rejects provenance from different patch sources', () => {
  const changedSource = { ...source, patch_sources: { 'SesWriter.java': 'new-source' } };
  assert.throws(() => validateEngineBuild(provenance, changedSource, 'built-jar'), /stale/);
});

test('rejects a build that omitted the upstream regression checks', () => {
  assert.throws(
    () => validateEngineBuild({ ...provenance, upstream_tests_passed: false }, source, 'built-jar'),
    /missing/,
  );
});
