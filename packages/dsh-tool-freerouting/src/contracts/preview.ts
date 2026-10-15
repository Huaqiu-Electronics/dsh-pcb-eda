import { z } from 'zod';

// Shared wire DTO only: no engine parser, Node APIs, or editor objects in the browser.
const coordinate = z.number().finite().min(-100000).max(100000);
const point = z.tuple([coordinate, coordinate]);
export const previewMetaSchema = z.object({
  revision: z.number().int().positive(),
  round: z.union([z.literal(1), z.literal(2)]),
  state: z.enum(['waiting', 'ready', 'unavailable']),
  final: z.boolean(),
  imported: z.boolean().default(false),
  updated_at: z.string(),
});
export const previewSceneSchema = z
  .object({
    layers: z.array(z.string().min(1).max(256)).min(1).max(64),
    outline: z.array(z.array(point).min(2).max(100000)).max(1000),
    paths: z
      .array(
        z.object({
          layer: z.string().max(256),
          width: z.number().positive().max(100),
          points: z.array(point).min(2).max(100000),
        }),
      )
      .max(50000),
    vias: z
      .array(
        z.object({
          at: point,
          diameter: z.number().positive().max(100),
          layers: z.array(z.string().max(256)).min(1).max(64),
        }),
      )
      .max(20000),
  })
  .superRefine((scene, context) => {
    const count = [...scene.outline, ...scene.paths.map((path) => path.points)].reduce(
      (sum, points) => sum + points.length,
      0,
    );
    if (
      count > 100000 ||
      scene.paths.some((path) => !scene.layers.includes(path.layer)) ||
      scene.vias.some((via) => via.layers.some((layer) => !scene.layers.includes(layer)))
    ) {
      context.addIssue({ code: 'custom', message: 'Invalid or oversized preview geometry' });
    }
  });
export const previewPayloadSchema = z.object({
  run_id: z.string().uuid(),
  revision: z.number().int().positive(),
  scene: previewSceneSchema,
});
export type PreviewScene = z.infer<typeof previewSceneSchema>;
export type PreviewMeta = z.infer<typeof previewMetaSchema>;
export type PreviewPayload = z.infer<typeof previewPayloadSchema>;
