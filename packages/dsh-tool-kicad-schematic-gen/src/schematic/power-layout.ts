/** Bounded, deterministic power-symbol placement; no topology inference. */
import type { FlatBounds } from './flat-layout.ts'
import type { FlatObject, FlatPoint } from './flat.ts'
import type { PowerLabelEntry, PowerLabelSpec } from './builder.ts'

export interface PowerPlacementPlan {
  placements: NonNullable<PowerLabelSpec['placements']>
  diagnostics: {
    plannedCount: number; rotatedCount: number; movedCount: number; candidateCount: number
    unresolved: Array<{ uuid: string; net: string; at: FlatPoint; obstacleUuids: string[] }>
    unmeasuredObjectUuids: string[]
  }
}
export interface PowerPlanningOptions extends Pick<PowerLabelSpec, 'libraryPath' | 'nets'> {
  clearanceMm?: number
  /** Maximum short cardinal lead, 0 disables movement. Default 5.08 mm. */
  maxMoveMm?: number
}
export interface PowerGeometry { body: FlatBounds; textSize: FlatPoint }
const EPS = 1e-6
const equal = (a: FlatPoint, b: FlatPoint) => Math.abs(a[0] - b[0]) < EPS && Math.abs(a[1] - b[1]) < EPS
const contains = (a: FlatPoint, b: FlatPoint, p: FlatPoint) =>
  Math.abs((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) < EPS
  && p[0] >= Math.min(a[0], b[0]) - EPS && p[0] <= Math.max(a[0], b[0]) + EPS
  && p[1] >= Math.min(a[1], b[1]) - EPS && p[1] <= Math.max(a[1], b[1]) + EPS

/** Whether a cardinal lead touches another segment anywhere other than its original anchor. */
function unsafeIntersection(a: FlatPoint, b: FlatPoint, c: FlatPoint, d: FlatPoint): boolean {
  const cross = (p: FlatPoint, q: FlatPoint) => p[0] * q[1] - p[1] * q[0]
  const r: FlatPoint = [b[0] - a[0], b[1] - a[1]], s: FlatPoint = [d[0] - c[0], d[1] - c[1]]
  const denominator = cross(r, s), offset: FlatPoint = [c[0] - a[0], c[1] - a[1]]
  if (Math.abs(denominator) < EPS) {
    if (Math.abs(cross(offset, r)) >= EPS) return false
    // Collinear overlap, including an existing-wire endpoint at the new location, is unsafe.
    return [c, d].some(p => contains(a, b, p) && !equal(p, a)) || contains(c, d, b)
  }
  const t = cross(offset, s) / denominator, u = cross(offset, r) / denominator
  return t > EPS && t <= 1 + EPS && u >= -EPS && u <= 1 + EPS
}
export function overlap(a: FlatBounds, b: FlatBounds, clearance = 0): boolean {
  return a.left - clearance < b.right && b.left < a.right + clearance
    && a.top - clearance < b.bottom && b.top < a.bottom + clearance
}
export function offsetBounds(bounds: FlatBounds, at: FlatPoint): FlatBounds {
  return { left: bounds.left + at[0], right: bounds.right + at[0], top: bounds.top + at[1], bottom: bounds.bottom + at[1] }
}
const centreBox = (at: FlatPoint, width: number, height: number): FlatBounds =>
  ({ left: at[0] - width / 2, right: at[0] + width / 2, top: at[1] - height / 2, bottom: at[1] + height / 2 })

export function planPowerLabels(labels: PowerLabelEntry[], objects: FlatObject[],
  geometry: (net: string, angle: 0 | 90 | 180 | 270) => PowerGeometry,
  pageSize: FlatPoint, options: Pick<PowerPlanningOptions, 'clearanceMm' | 'maxMoveMm'>): PowerPlacementPlan {
  const clearance = options.clearanceMm ?? 0.6, maxMove = options.maxMoveMm ?? 5.08
  if (!Number.isFinite(clearance) || clearance < 0 || clearance > 3) throw new Error('Power clearanceMm must be between 0 and 3')
  if (!Number.isFinite(maxMove) || maxMove < 0 || maxMove > 10.16) throw new Error('Power maxMoveMm must be between 0 and 10.16')
  const ids = new Set(labels.map(label => label.uuid))
  const obstacles = objects.filter(object => !ids.has(object.uuid) && !['rectangle', 'junction', 'no_connect'].includes(object.type))
  const placed: Array<{ uuid: string; body: FlatBounds; text: FlatBounds }> = []
  const leads: Array<{ from: FlatPoint; to: FlatPoint }> = []
  const placements: PowerPlacementPlan['placements'] = {}
  const diagnostics: PowerPlacementPlan['diagnostics'] = { plannedCount: labels.length, rotatedCount: 0, movedCount: 0,
    candidateCount: 0, unresolved: [], unmeasuredObjectUuids: obstacles.filter(o => !o.bounds).map(o => o.uuid) }
  const inside = (box: FlatBounds) => box.left >= 0 && box.top >= 0 && box.right <= pageSize[0] && box.bottom <= pageSize[1]
  // Tie-breaking uses stable geometry and provenance, never fresh UUIDs.
  const ordered = [...labels].sort((a, b) => (a.module ?? '').localeCompare(b.module ?? '')
    || a.at[0] - b.at[0] || a.at[1] - b.at[1] || a.net.localeCompare(b.net))
  for (const label of ordered) {
    const locations: FlatPoint[] = [[...label.at]]
    for (const distance of [2.54, 5.08, 7.62, 10.16].filter(d => d <= maxMove + EPS)) {
      for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) locations.push([label.at[0] + dx! * distance, label.at[1] + dy! * distance])
    }
    let best: { at: FlatPoint; angle: 0 | 90 | 180 | 270; valueAt: FlatPoint; body: FlatBounds; text: FlatBounds; score: number; conflicts: string[] } | undefined
    for (const at of locations) {
      const moved = !equal(at, label.at)
      if (moved && (obstacles.some(o =>
        o.type === 'wire' && o.from && o.to && unsafeIntersection(label.at, at, o.from, o.to)
        || o.pins?.some(pin => contains(label.at, at, pin.at) && !equal(pin.at, label.at)))
        || leads.some(lead => unsafeIntersection(label.at, at, lead.from, lead.to))
        || ordered.some(other => other.uuid !== label.uuid && contains(label.at, at, other.at) && !equal(other.at, label.at)))) continue
      // Conservative object bounds can include pin text. Never exempt an entire
      // owning symbol: doing so could route a lead through its body.
      const leadBox = centreBox([(label.at[0] + at[0]) / 2, (label.at[1] + at[1]) / 2],
        Math.abs(at[0] - label.at[0]) + 0.05, Math.abs(at[1] - label.at[1]) + 0.05)
      if (moved && obstacles.some(o => o.type !== 'wire' && o.bounds && overlap(leadBox, o.bounds))) continue
      if (moved && placed.some(o => overlap(leadBox, o.body) || overlap(leadBox, o.text))) continue
      for (const angle of [0, 90, 270, 180] as const) {
        const metrics = geometry(label.net, angle), body = offsetBounds(metrics.body, at)
        if (!inside(body)) continue
        const [width, height] = metrics.textSize
        const cx = (body.left + body.right) / 2, cy = (body.top + body.bottom) / 2
        // Put the text beyond the actual rotated body, horizontally readable.
        const textPositions: FlatPoint[] = [
          [cx, body.bottom + clearance + height / 2], [cx, body.top - clearance - height / 2],
          [body.left - clearance - width / 2, cy], [body.right + clearance + width / 2, cy],
        ]
        // For an upward body, prefer text above; for horizontal bodies, prefer its outward side.
        if (cy < at[1] - EPS) [textPositions[0], textPositions[1]] = [textPositions[1]!, textPositions[0]!]
        if (cx < at[0] - EPS) textPositions.unshift(textPositions.splice(2, 1)[0]!)
        if (cx > at[0] + EPS) textPositions.unshift(textPositions.splice(3, 1)[0]!)
        for (let textIndex = 0; textIndex < textPositions.length; textIndex++) {
          diagnostics.candidateCount++
          const valueAt = textPositions[textIndex]!, text = centreBox(valueAt, width, height)
          if (!inside(text)) continue
          const conflicts = obstacles.filter(o => {
            if (!o.bounds) return false
            const attached = o.type === 'wire' && o.from && o.to && contains(o.from, o.to, at)
            return (!attached && overlap(body, o.bounds, clearance)) || overlap(text, o.bounds, clearance)
          }).map(o => o.uuid)
          for (const other of placed) if ([other.body, other.text].some(box => overlap(body, box, clearance) || overlap(text, box, clearance))) conflicts.push(other.uuid)
          for (const lead of leads) {
            const bounds = centreBox([(lead.from[0] + lead.to[0]) / 2, (lead.from[1] + lead.to[1]) / 2],
              Math.abs(lead.to[0] - lead.from[0]) + 0.05, Math.abs(lead.to[1] - lead.from[1]) + 0.05)
            if (overlap(body, bounds, clearance) || overlap(text, bounds, clearance)) conflicts.push('planned-power-lead')
          }
          if (moved && overlap(text, leadBox, clearance)) conflicts.push('own-power-lead')
          const unique = [...new Set(conflicts)]
          const score = unique.length * 10000 + (moved ? 100 + Math.abs(at[0] - label.at[0]) + Math.abs(at[1] - label.at[1]) : 0)
            + (angle === 0 ? 0 : angle === 180 ? 20 : 10) + textIndex
          if (!best || score < best.score) best = { at, angle, valueAt, body, text, score, conflicts: unique }
        }
      }
    }
    if (!best) throw new Error(`POWER_PLACEMENT_UNAVAILABLE: no safe in-page candidate for ${label.net} at ${label.at.join(',')}`)
    placements[label.uuid] = { at: best.at, angle: best.angle, valueAt: best.valueAt }
    placed.push({ uuid: label.uuid, body: best.body, text: best.text })
    if (best.angle !== 0) diagnostics.rotatedCount++
    if (!equal(best.at, label.at)) { diagnostics.movedCount++; leads.push({ from: label.at, to: best.at }) }
    if (best.conflicts.length) diagnostics.unresolved.push({ uuid: label.uuid, net: label.net, at: best.at, obstacleUuids: best.conflicts })
  }
  return { placements, diagnostics }
}
