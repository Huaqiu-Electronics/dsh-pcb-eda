/**
 * OPT-IN live probe for the AI-usage upstream.
 *
 * Skipped unless `DSH_LIVE_AI_TOKEN` is set, so the default suite never touches
 * the network. Run it when the balance bar looks wrong and you need to separate
 * "the plugin is broken" from "the account/endpoint is broken":
 *
 *   DSH_LIVE_AI_TOKEN=<access token> pnpm test live-ai-usage
 *
 * It exercises the REAL node-side `fetchAiTokenUsage` (same URL, same `X-Token`
 * header, same envelope) because that call is the one thing the mocked unit
 * tests cannot prove: the endpoint is served over plain `http`, and only a real
 * socket shows whether that is still reachable and still answers with the
 * documented `{ code: 200000, result }` envelope.
 */
import { describe, expect, it } from 'vitest'
import { AI_USAGE_URL, fetchAiTokenUsage } from '../src/routes.js'

const token = process.env.DSH_LIVE_AI_TOKEN

describe.skipIf(!token)('fetchAiTokenUsage (live)', () => {
  it('resolves the account balance from the real endpoint', async () => {
    const usage = await fetchAiTokenUsage(token!)
    // A block (ATS/CORS/host unreachable) yields null — surface the URL so the
    // failure reads as what it is rather than as a bare `expect(null)`.
    expect(usage, `no usage returned by ${AI_USAGE_URL}`).not.toBeNull()
    for (const [key, value] of Object.entries(usage!)) {
      expect(Number.isFinite(value), `${key} is not a finite number: ${value}`).toBe(true)
      expect(value).toBeGreaterThanOrEqual(0)
    }
    // Visible in the run output when probing by hand.
    console.log('live AI usage:', usage)
  })
})
