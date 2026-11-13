/**
 * OPT-IN live probe for the AI-usage upstream.
 *
 * Skipped unless `DSH_LIVE_AI_TOKEN` is set, so the default suite never touches
 * the network. Run it when the balance bar looks wrong and you need to separate
 * "the plugin is broken" from "the account/endpoint is broken":
 *
 *   DSH_LIVE_AI_TOKEN=<access token> pnpm test live-ai-usage
 *
 * Set `DSH_LIVE_AI_USAGE_URL` to probe a non-default environment.
 *
 * It exercises the REAL node-side `fetchAiUsage` (same URL, same `X-Token`
 * header, same `result[]` envelope) because that call is the one thing the
 * mocked unit tests cannot prove: the endpoint is served over plain `http`, and
 * only a real socket shows whether that is still reachable and still answers
 * with the documented `{ code: 200000, result: [...] }` envelope.
 */
import { describe, expect, it } from 'vitest'
import { fetchAiUsage } from '../src/routes.js'

const token = process.env.DSH_LIVE_AI_TOKEN
// The production code has no hardcoded env URL; this optional probe keeps its
// TEST default (override with DSH_LIVE_AI_USAGE_URL for prod).
const AI_USAGE_URL =
  process.env.DSH_LIVE_AI_USAGE_URL
  ?? 'http://www.fdatasheets.com/sub-api/subscriptions/balances/current'

describe.skipIf(!token)('fetchAiUsage (live)', () => {
  it('resolves the AI Points remaining percentage from the real endpoint', async () => {
    const usage = await fetchAiUsage(token!, AI_USAGE_URL)
    // A block (ATS/CORS/host unreachable) yields null — surface the URL so the
    // failure reads as what it is rather than as a bare `expect(null)`.
    expect(usage, `no usage returned by ${AI_USAGE_URL}`).not.toBeNull()
    expect(Number.isFinite(usage!.quotaRemainPercent)).toBe(true)
    expect(usage!.quotaRemainPercent).toBeGreaterThanOrEqual(0)
    expect(usage!.quotaRemainPercent).toBeLessThanOrEqual(100)
    // Visible in the run output when probing by hand.
    console.log('live AI usage:', usage)
  })
})
