import { parseSExprList, type SExpr } from './statistics.js';
import { previewSceneSchema, type PreviewScene } from '../contracts/preview.js';

const MAX_BYTES = 2 * 1024 * 1024;
type List = SExpr[];
type Point = [number, number];
const children = (node: List, name: string): List[] =>
  node.filter((item): item is List => Array.isArray(item) && item[0] === name);
const child = (node: List, name: string): List => children(node, name)[0] ?? [];
function atom(value: SExpr | undefined): string {
  if (typeof value !== 'string') {
    throw new Error('Missing preview atom');
  }
  return value;
}
function number(value: SExpr | undefined): number {
  const text = atom(value);
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) {
    throw new Error('Invalid preview number');
  }
  const result = Number(text);
  if (!Number.isFinite(result)) {
    throw new Error('Nonfinite preview number');
  }
  return result;
}
function millimetres(unit: SExpr | undefined): number {
  const units: Record<string, number> = { mm: 1, um: 0.001, mil: 0.0254, inch: 25.4 };
  const scale = units[atom(unit)];
  if (!scale) {
    throw new Error('Unsupported preview unit');
  }
  return scale;
}
function document(source: string, kind: string): List {
  if (Buffer.byteLength(source, 'utf8') > MAX_BYTES) {
    throw new Error('Preview source too large');
  }
  const roots = parseSExprList(source, true);
  if (roots.length !== 1 || !Array.isArray(roots[0]) || roots[0][0] !== kind) {
    throw new Error('Invalid preview document');
  }
  return roots[0];
}
function points(values: SExpr[], scale: number): Point[] {
  if (values.length < 4 || values.length % 2) {
    throw new Error('Incomplete preview path');
  }
  const result: Point[] = [];
  for (let i = 0; i < values.length; i += 2) {
    result.push([number(values[i]) * scale, -number(values[i + 1]) * scale]);
  }
  return result;
}

/** Read-only, bounded projection. Never used to validate or import copper. */
export function createPreviewReader(dsn: string): (ses: string) => PreviewScene {
  const board = document(dsn, 'pcb');
  const structure = child(board, 'structure');
  const layers = children(structure, 'layer').map((layer) => atom(layer[1]));
  // DSN coordinates use the declared unit; its resolution is precision, not a divisor.
  const dsnUnit = child(board, 'unit')[1] ?? child(board, 'resolution')[1];
  const dsnScale = millimetres(dsnUnit);
  const outline: Point[][] = [];
  for (const boundary of children(structure, 'boundary')) {
    for (const path of children(boundary, 'path')) {
      outline.push(points(path.slice(3), dsnScale));
    }
    for (const rect of children(boundary, 'rect')) {
      const corners = points(rect.slice(2), dsnScale);
      if (corners.length !== 2) {
        throw new Error('Invalid boundary rectangle');
      }
      const [a, b] = corners as [Point, Point];
      outline.push([a, [b[0], a[1]], b, [a[0], b[1]], a]);
    }
  }
  previewSceneSchema.parse({ layers, outline, paths: [], vias: [] });
  return (source) => {
    const session = document(source, 'session');
    const routes = child(session, 'routes');
    const resolution = child(routes, 'resolution');
    const divisor = number(resolution[2]);
    if (divisor <= 0) {
      throw new Error('Invalid preview resolution');
    }
    const scale = millimetres(resolution[1]) / divisor;
    const pads = new Map<string, { diameter: number; layers: string[] }>();
    for (const pad of children(child(routes, 'library_out'), 'padstack')) {
      const circles = children(pad, 'shape')
        .map((shape) => child(shape, 'circle'))
        .filter((circle) => circle.length);
      if (circles.length) {
        pads.set(atom(pad[1]), {
          diameter: Math.max(...circles.map((circle) => number(circle[2]) * scale)),
          layers: circles.map((circle) => atom(circle[1])),
        });
      }
    }
    const paths: PreviewScene['paths'] = [];
    const vias: PreviewScene['vias'] = [];
    for (const net of children(child(routes, 'network_out'), 'net')) {
      for (const wire of children(net, 'wire')) {
        const path = child(wire, 'path');
        paths.push({ layer: atom(path[1]), width: number(path[2]) * scale, points: points(path.slice(3), scale) });
      }
      for (const via of children(net, 'via')) {
        const pad = pads.get(atom(via[1]));
        if (!pad) {
          throw new Error('Unknown preview via');
        }
        vias.push({ at: [number(via[2]) * scale, -number(via[3]) * scale], ...pad });
      }
    }
    return previewSceneSchema.parse({ layers, outline, paths, vias });
  };
}
