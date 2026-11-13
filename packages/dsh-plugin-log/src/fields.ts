/**
 * Record fields owned by `@huaqiu/dsh-plugin-log`.
 *
 * Kept in a leaf module with NO runtime imports so the browser half can share
 * the exact same reserved-field rule without pulling `node:fs` / `node:os`
 * into a browser bundle.
 */

/**
 * A plugin's `fields` object may not override any of these. Without the rule a
 * plugin could rewrite its own `pluginId` (mis-attributing records to another
 * plugin) or promote a `debug` line to `error` — and the log would stop being
 * evidence.
 */
export const RESERVED_FIELDS: ReadonlySet<string> = new Set([
  'time',
  'ts',
  'level',
  'msg',
  'pid',
  'schemaVersion',
  'installationId',
  'hostType',
  'hostInstanceId',
  'edgeInstanceId',
  'dshInstanceId',
  'pluginId',
  // Legacy alias for `pluginId`; still reserved so one plugin cannot
  // mis-attribute records to another.
  'component',
])
