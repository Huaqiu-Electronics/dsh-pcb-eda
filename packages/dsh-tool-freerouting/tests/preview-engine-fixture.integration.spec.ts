import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { createPreviewReader } from '../src/runs/preview.js';

it('projects two changing SES snapshots captured from the bundled engine while RUNNING', async () => {
  const fixture = (name: string) => readFile(new URL(`./fixtures/live-preview/${name}`, import.meta.url), 'utf8');
  const reader = createPreviewReader(await fixture('board.dsn'));
  const first = reader(await fixture('snapshot-1.ses'));
  const second = reader(await fixture('snapshot-2.ses'));
  expect(first.paths.length).toBeGreaterThan(0);
  expect(second.paths.length).toBeGreaterThan(0);
  expect(second).not.toEqual(first);
  // JSON is the public wire contract; it normalizes JavaScript negative zero.
  expect(JSON.parse(JSON.stringify(first.outline[0]))).toEqual([
    [0, 0],
    [50, 0],
    [50, -45],
    [0, -45],
    [0, 0],
  ]);
  for (const scene of [first, second]) {
    for (const path of scene.paths) {
      expect(path.width).toBeCloseTo(0.2);
      for (const [x, y] of path.points) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(50);
        expect(y).toBeGreaterThanOrEqual(-45);
        expect(y).toBeLessThanOrEqual(0);
      }
    }
  }
});
