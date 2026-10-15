import { expect, it } from 'vitest';
import { createPreviewReader } from '../src/runs/preview.js';
import { previewSceneSchema } from '../src/contracts/preview.js';
import { parseSExprList } from '../src/runs/statistics.js';
import { previewDsn as dsn, previewSes as ses } from './preview-fixture.js';

it('maps DSN units and SES resolution independently, flips Y, and retains layers and via geometry', () => {
  const scene = createPreviewReader(dsn)(ses);
  expect(scene.outline[0]).toEqual([
    [0, 10],
    [20, 10],
    [20, 30],
    [0, 30],
    [0, 10],
  ]);
  expect(scene.paths).toEqual([
    {
      layer: 'F.Cu',
      width: 0.2,
      points: [
        [1, 11],
        [19, 29],
      ],
    },
    {
      layer: 'B.Cu',
      width: 0.25,
      points: [
        [1, 11],
        [5, 12],
      ],
    },
  ]);
  expect(scene.vias).toEqual([{ at: [1, 11], diameter: 0.6, layers: ['F.Cu', 'B.Cu'] }]);
});
it('rejects partial snapshots and unsafe/unsupported geometry instead of presenting misleading paths', () => {
  const read = createPreviewReader(dsn);
  for (const invalid of [
    ses.slice(0, -1),
    ses + ')',
    ses.replace('2000 10000', 'NaN 10000'),
    ses.replace('path F.Cu', 'path Unknown'),
    ses.replace('um 10', 'nm 10'),
    ses.replace('via Via', 'via Missing'),
    '('.repeat(70) + ')'.repeat(70),
    'x'.repeat(2 * 1024 * 1024 + 1),
  ]) {
    expect(() => read(invalid)).toThrow();
  }
  expect(() => parseSExprList('(pcb "unterminated', true)).toThrow();
  expect(() => parseSExprList('(pcb', false)).not.toThrow();
  expect(
    previewSceneSchema.safeParse({
      layers: ['F.Cu'],
      outline: [],
      paths: [
        {
          layer: '<script>',
          width: 0.2,
          points: [
            [1, 2],
            [3, 4],
          ],
        },
      ],
      vias: [],
    }).success,
  ).toBe(false);
});
it('supports millimetre and inch coordinates, and rectangle board outlines', () => {
  const read = createPreviewReader('(pcb b (unit inch) (structure (layer F.Cu) (boundary (rect pcb 0 0 1 1))))');
  const scene = read(
    '(session b (routes (resolution mm 1000) (network_out (net N (wire (path F.Cu 200 1000 -2000 3000 -4000))))))',
  );
  expect(scene.outline[0]?.[2]).toEqual([25.4, -25.4]);
  expect(scene.paths[0]).toMatchObject({
    width: 0.2,
    points: [
      [1, 2],
      [3, 4],
    ],
  });
});
