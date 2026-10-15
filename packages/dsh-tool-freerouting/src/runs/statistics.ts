/**
 * Pure, KiCad-free parsing of Specctra DSN/SES text into routing counters.
 *
 * Everything here runs server-side; the client bundle must not import it.
 *
 * Two dialects matter and they are handled differently on purpose:
 *
 * - DSN net names come from a regex, not an s-expression walk, because a real KiCad
 *   DSN header contains `(parser (string_quote ") …)`. That lone `"` defeats any
 *   quote-aware tokenizer (the Python reference `specctra/parser.py` has the same
 *   blind spot), so the proven regex stays exactly as it was.
 * - SES wires/vias are counted with a small s-expression tokenizer that tolerates
 *   `;` comments and the `(string_quote ")` quirk, then mirrors the Python
 *   importer's `_collect_wires_recursive`: a `(net NAME …)` head pushes NAME as the
 *   current net for its child wires/vias, and both the flat `(path layer w x y …)`
 *   and the point-list `(path (pt x y) …)` dialects are understood.
 */

/** A parsed s-expression node: either an atom (kept as a string) or a nested list. */
export type SExpr = string | SExpr[];

/** Counters lifted from a FreeRouting SES session. */
export interface SesCounters {
  /** Distinct nets that received at least one wire segment or via. */
  nets: string[];
  /** Track segments; a multi-point path contributes `points - 1` segments. */
  segments: number;
  /** Placed vias. */
  vias: number;
  /** Wire blocks (each may hold one multi-point path). */
  wires: number;
}

/** Numeric fields lifted out of FreeRouting's nested, build-dependent `statistics`. */
export interface UpstreamCounters {
  bends?: number;
  connections?: number;
  layers?: number;
  routedConnections?: number;
  segments?: number;
  unroutedConnections?: number;
  vias?: number;
  violations?: number;
}

/** Upstream counters plus the net-level routed/unrouted split computed locally. */
export interface RoutingSummary extends UpstreamCounters {
  routedNets?: number;
  unroutedNetNames?: string[];
  unroutedNets?: number;
}

export interface RoutingSummaryInput {
  dsnNets: readonly string[];
  ses: SesCounters;
  statistics?: Record<string, unknown>;
  targetNets?: readonly string[];
}

/** Cap on how many unrouted net names we keep, so the payload stays small. */
const MAX_UNROUTED_NET_NAMES = 12;
/** `(net INDEX NAME)` definitions start with a bare integer, unlike `(net NAME …)`. */
const INTEGER_PATTERN = /^\d+$/;
/** A coordinate/width atom: integer, decimal, signed, or scientific. */
const NUMBER_PATTERN = /^[+-]?(\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * Candidate dotted paths (first finite number wins) for each counter, covering the
 * field-name drift between FreeRouting builds (`vias` vs `vias.count` vs `via_count`,
 * `traces` as a number vs `traces.count` inside an object).
 */
const UPSTREAM_NUMBER_PATHS: ReadonlyArray<readonly [keyof UpstreamCounters, readonly string[]]> = [
  ['bends', ['traces.bends', 'bends.count', 'bends']],
  ['connections', ['connections.total', 'connections.count', 'connections']],
  ['layers', ['board.layers', 'layers.count', 'layers']],
  ['routedConnections', ['connections.routed', 'routed_connections']],
  ['segments', ['traces.count', 'traces', 'wires.count', 'segment_count']],
  ['unroutedConnections', ['connections.remaining', 'connections.unrouted', 'unconnected.count']],
  ['vias', ['vias.count', 'vias', 'via_count']],
  [
    'violations',
    ['clearance_violations.count', 'clearance_violations', 'violations.count', 'violations', 'drc_violations'],
  ],
];

/**
 * Extract the declared net names from a Specctra DSN (`(net NAME` / `(net "NAME"`).
 * KiCad writes one `(net …)` per board net in the network section; quoted forms cover
 * names with spaces/special chars. Regex-based on purpose — see the module note about
 * `(string_quote ")`.
 */
export function parseDsnNetNames(dsn: string): string[] {
  const names = new Set<string>();
  const pattern = /\(net\s+("(?:[^"\\]|\\.)*"|[^\s()]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(dsn)) !== null) {
    const token = match[1];
    if (token === undefined) {
      continue;
    }
    const raw = token.startsWith('"') && token.endsWith('"') ? token.slice(1, -1).replace(/\\(.)/g, '$1') : token;
    if (raw !== '') {
      names.add(raw);
    }
  }
  return [...names];
}

/**
 * Count the pins each declared DSN net connects, e.g. `(net GND (pins U1-1 C1-2))` → 2.
 * KiCad writes one `(pins …)` block per net in the network section; nets without such a
 * block stay out of the map so callers can keep them (an unknown pin count is safer
 * than silently dropping a real net). Used to recognise single-pad pseudo-nets such as
 * `unconnected-(P5-Pad1)`, which have nothing to route.
 */
export function parseDsnNetPinCounts(dsn: string): Map<string, number> {
  const counts = new Map<string, number>();
  const pattern = /\(net\s+("(?:[^"\\]|\\.)*"|[^\s()]+)\s*\(\s*pins\s*([^)]*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(dsn)) !== null) {
    const token = match[1];
    const pins = match[2];
    if (token === undefined || pins === undefined) {
      continue;
    }
    const raw = token.startsWith('"') && token.endsWith('"') ? token.slice(1, -1).replace(/\\(.)/g, '$1') : token;
    if (raw === '' || INTEGER_PATTERN.test(raw)) {
      continue;
    }
    const pinCount = (pins.match(/"(?:[^"\\]|\\.)*"|[^\s()]+/g) ?? []).length;
    counts.set(raw, (counts.get(raw) ?? 0) + pinCount);
  }
  return counts;
}

function isSpace(char: string | undefined): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r';
}

function nextNonSpace(source: string, from: number): string {
  let index = from;
  while (index < source.length && isSpace(source[index])) {
    index += 1;
  }
  return source[index] ?? '';
}

/**
 * Tokenize and nest an s-expression document into `SExpr` nodes. Atoms stay strings
 * (numbers are recognised later by pattern), quoted strings lose their quotes, `;`
 * starts a line comment, and a `"` immediately followed by `)` is kept as a literal
 * token so KiCad's `(string_quote ")` header cannot swallow the rest of the document.
 * Unbalanced input degrades gracefully instead of throwing.
 */
export function parseSExprList(source: string, strict = false): SExpr[] {
  const roots: SExpr[] = [];
  const stack: SExpr[][] = [roots];
  const current = (): SExpr[] => stack[stack.length - 1] ?? roots;
  let token = '';
  let quoted: string | undefined;

  const flush = (): void => {
    if (token !== '') {
      current().push(token);
      token = '';
    }
  };

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] ?? '';
    if (quoted !== undefined) {
      if (char === '\\' && index + 1 < source.length) {
        quoted += source[index + 1] ?? '';
        index += 1;
      } else if (char === '"') {
        current().push(quoted);
        quoted = undefined;
      } else {
        quoted += char;
      }
      continue;
    }
    if (char === '"') {
      flush();
      if (nextNonSpace(source, index + 1) === ')') {
        current().push('"');
      } else {
        quoted = '';
      }
    } else if (char === ';') {
      flush();
      while (index + 1 < source.length && source[index + 1] !== '\n') {
        index += 1;
      }
    } else if (char === '(') {
      flush();
      if (strict && stack.length >= 64) {
        throw new Error('S-expression nesting limit exceeded');
      }
      const node: SExpr[] = [];
      current().push(node);
      stack.push(node);
    } else if (char === ')') {
      flush();
      if (stack.length > 1) {
        stack.pop();
      } else if (strict) {
        throw new Error('Unexpected closing parenthesis');
      }
    } else if (isSpace(char)) {
      flush();
    } else {
      token += char;
    }
  }
  flush();
  if (strict && (quoted !== undefined || stack.length !== 1)) {
    throw new Error('Incomplete s-expression');
  }
  return roots;
}

/**
 * Count wires/vias/segments in a SES and collect the nets that actually got copper.
 * Mirrors the Python importer's recursive walk: a `(net NAME …)` head pushes NAME as
 * the current net for its child wires/vias; a net is only counted as routed once a
 * wire segment or via lands on it, so an empty `(net …)` stays unrouted.
 */
export function countSes(ses: string): SesCounters {
  const roots = parseSExprList(ses);
  const nets = new Set<string>();
  let segments = 0;
  let vias = 0;
  let wires = 0;

  const walk = (node: SExpr | undefined, currentNet: string | undefined): void => {
    if (!Array.isArray(node) || node.length === 0) {
      return;
    }
    const head = typeof node[0] === 'string' ? node[0].toLowerCase() : '';
    if (head === 'net') {
      const first = node[1];
      // `(net NAME …)` attributes its children; `(net INDEX NAME)` is only a
      // definition (no copper inside), so it is skipped like the Python importer.
      if (typeof first === 'string' && first !== '' && !INTEGER_PATTERN.test(first)) {
        for (let index = 2; index < node.length; index += 1) {
          walk(node[index], first);
        }
      }
      return;
    }
    if (head === 'wire') {
      wires += 1;
      const wireSegments = countWireSegments(node);
      segments += wireSegments;
      const net = nodeNetName(node) ?? currentNet;
      if (wireSegments > 0 && net !== undefined) {
        nets.add(net);
      }
      return;
    }
    if (head === 'via') {
      vias += 1;
      const net = nodeNetName(node) ?? currentNet;
      if (net !== undefined) {
        nets.add(net);
      }
      return;
    }
    for (let index = 1; index < node.length; index += 1) {
      walk(node[index], currentNet);
    }
  };

  for (const root of roots) {
    walk(root, undefined);
  }
  return { nets: [...nets], segments, vias, wires };
}

/** A wire/via's own `(net NAME)` child, if present (FreeRouting usually relies on the parent). */
function nodeNetName(node: SExpr[]): string | undefined {
  for (const child of node) {
    if (Array.isArray(child) && child[0] === 'net') {
      const name = child[1];
      if (typeof name === 'string' && name !== '' && !INTEGER_PATTERN.test(name)) {
        return name;
      }
    }
  }
  return undefined;
}

/** Track segments in one wire: the sum over each of its `(path …)` children. */
function countWireSegments(wire: SExpr[]): number {
  let total = 0;
  for (const child of wire) {
    if (Array.isArray(child) && child[0] === 'path') {
      total += countPathSegments(child);
    }
  }
  return total;
}

/**
 * Segments in a path = `points - 1`. Supports the point-list dialect
 * `(path (pt x y) (pt x y) …)` and the flat dialect `(path layer width x1 y1 x2 y2 …)`
 * where the first three atoms (head, layer, width) are not coordinates.
 */
function countPathSegments(path: SExpr[]): number {
  let points = 0;
  for (const child of path) {
    if (Array.isArray(child) && child[0] === 'pt') {
      points += 1;
    }
  }
  if (points > 0) {
    return points - 1;
  }
  let coords = 0;
  for (let index = 3; index < path.length; index += 1) {
    const atom = path[index];
    if (typeof atom === 'string' && NUMBER_PATTERN.test(atom)) {
      coords += 1;
    }
  }
  return Math.max(0, Math.floor(coords / 2) - 1);
}

/**
 * Lift the numeric counters out of FreeRouting's nested, build-dependent `statistics`
 * blob. Any field can be null/object/missing, so only finite numbers are kept and a
 * missing blob yields `{}` — statistics are cosmetic and must never throw.
 */
export function normalizeStatistics(statistics: Record<string, unknown> | undefined): UpstreamCounters {
  const result: UpstreamCounters = {};
  if (statistics === undefined) {
    return result;
  }
  for (const [key, paths] of UPSTREAM_NUMBER_PATHS) {
    for (const path of paths) {
      const value = readNumberPath(statistics, path);
      if (value !== undefined) {
        result[key] = value;
        break;
      }
    }
  }
  return result;
}

function readNumberPath(source: Record<string, unknown>, path: string): number | undefined {
  let node: unknown = source;
  for (const part of path.split('.')) {
    if (typeof node !== 'object' || node === null) {
      return undefined;
    }
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'number' && Number.isFinite(node) ? node : undefined;
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * Combine the SES counters, the target net list, and the upstream statistics into one
 * summary. The routed/unrouted split is only asserted when it can be trusted:
 * - the SES carries net attribution → diff it against the targets;
 * - the SES is completely empty → every target is unrouted;
 * - otherwise (e.g. FreeRouting's net-less `(wiring …)` dialect) both stay `undefined`
 *   so the card hides the cells instead of calling a routed board a failure.
 */
export function summarizeRouting(input: RoutingSummaryInput): RoutingSummary {
  const summary: RoutingSummary = { ...normalizeStatistics(input.statistics) };
  if (summary.segments === undefined) {
    summary.segments = input.ses.segments;
  }
  if (summary.vias === undefined) {
    summary.vias = input.ses.vias;
  }
  const targets = dedupe(input.targetNets ?? input.dsnNets);
  if (targets.length === 0) {
    return summary;
  }
  if (input.ses.nets.length > 0) {
    const routed = new Set(input.ses.nets);
    const unrouted = targets.filter((net) => !routed.has(net));
    summary.routedNets = targets.length - unrouted.length;
    summary.unroutedNets = unrouted.length;
    if (unrouted.length > 0) {
      summary.unroutedNetNames = unrouted.slice(0, MAX_UNROUTED_NET_NAMES);
    }
  } else if (input.ses.wires === 0 && input.ses.vias === 0) {
    summary.routedNets = 0;
    summary.unroutedNets = targets.length;
    summary.unroutedNetNames = targets.slice(0, MAX_UNROUTED_NET_NAMES);
  }
  return summary;
}

/**
 * One Chinese sentence for the run log, e.g.
 * `已布通网络 3/4，未布通 1 个网络：USB_DP，走线 512 段，过孔 18 个，违规 0 处`.
 */
export function describeRoutingSummary(summary: RoutingSummary, targetNets: number): string {
  const parts: string[] = [];
  if (summary.routedNets !== undefined) {
    const total = targetNets > 0 ? targetNets : summary.routedNets + (summary.unroutedNets ?? 0);
    parts.push(`已布通网络 ${summary.routedNets}/${total}`);
  }
  if (summary.unroutedNets !== undefined && summary.unroutedNets > 0) {
    const names = summary.unroutedNetNames ?? [];
    parts.push(
      names.length > 0
        ? `未布通 ${summary.unroutedNets} 个网络：${names.join(', ')}`
        : `未布通 ${summary.unroutedNets} 个网络`,
    );
  }
  if (summary.segments !== undefined) {
    parts.push(`走线 ${summary.segments} 段`);
  }
  if (summary.vias !== undefined) {
    parts.push(`过孔 ${summary.vias} 个`);
  }
  if (summary.violations !== undefined) {
    parts.push(`违规 ${summary.violations} 处`);
  }
  return parts.join('，');
}
