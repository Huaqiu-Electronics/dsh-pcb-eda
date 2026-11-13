/**
 * The sidebar toolbutton's numeric badge — one pure function, no DOM, no
 * store, so the rule can be tested on its own.
 *
 * It answers one question: how many updates does this EDA install still have
 * for the user? That is every actionable plugin item plus the HQ Edge runtime
 * offer when hq-edge reports one:
 *
 *   - **plugin items** — compatible `update` + `install`, minus whatever the
 *     user muted ({@link actionableUpdateCount});
 *   - **the HQ Edge runtime update, as one** — a different deliverable with its
 *     own card and its own confirm flow, but still an available update, and
 *     leaving it out of the only number on the sidebar hid a pending runtime
 *     upgrade until the panel was opened. It counts as ONE (a runtime swap is a
 *     single action, however many manifest entries it was picked from) and it
 *     survives a muted plugin offer, because the two offers are independent —
 *     ignoring this release set must not hide a newer runtime.
 *
 * What is NOT counted: the durable job history. It is permanent
 * (`listRecent(20)`, survives restarts), so turning any settled job — even a
 * successful install — into a "1" latched the badge on forever. That was the
 * original bug; a job is only allowed to speak while it is still RUNNING.
 *
 * @module
 */
import {
  TERMINAL_PHASES,
  runtimeUpdateOffered,
  type PluginUpdateReport,
  type UpdateJob,
} from './api.js'
import { actionableUpdateCount } from './version.js'

/**
 * The badge value for one snapshot of `(report, active job)`.
 *
 * @param report - the latest plugin-update report, or null before the first
 *   read. Null contributes nothing (never a placeholder count).
 * @param activeJob - the job the server reports as active, or null when idle.
 *   A RUNNING job counts as 1 only when there is nothing actionable to show,
 *   so the row still signals in-flight work; a TERMINAL job contributes
 *   nothing — it is history.
 * @returns the number to render; 0 means "no badge at all".
 */
export function badgeCountFor(
  report: PluginUpdateReport | null,
  activeJob: UpdateJob | null,
): number {
  if (report !== null) {
    // Plugin items already collapse to 0 when the offer is muted; the runtime
    // is an independent offer and keeps its own count.
    const plugin = actionableUpdateCount(report)
    const runtime = runtimeUpdateOffered(report.runtime) ? 1 : 0
    const total = plugin + runtime
    if (total > 0) return total
  }
  if (activeJob !== null && !TERMINAL_PHASES.has(activeJob.phase)) return 1
  return 0
}
