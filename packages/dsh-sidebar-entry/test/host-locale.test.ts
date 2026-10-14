// @vitest-environment jsdom
/**
 * Host-locale helpers used by every family sidebar row: `<html lang>` is the
 * single source `dsh-client-locale` rewrites on a language change (dsh web and
 * HQ Edge alike), so the rows read it instead of importing a locale service.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { detectHostLocale, observeHostLocale, type HostLocale } from '../src/index.js'

describe('detectHostLocale', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('lang')
  })

  it('returns undefined when the attribute is absent or unsupported', () => {
    expect(detectHostLocale()).toBeUndefined()
    document.documentElement.setAttribute('lang', 'ja-JP')
    expect(detectHostLocale()).toBeUndefined()
  })

  it('reduces a regional tag to its primary subtag', () => {
    document.documentElement.setAttribute('lang', 'zh-CN')
    expect(detectHostLocale()).toBe('zh')
    document.documentElement.setAttribute('lang', 'en-US')
    expect(detectHostLocale()).toBe('en')
    document.documentElement.setAttribute('lang', 'EN')
    expect(detectHostLocale()).toBe('en')
  })
})

describe('observeHostLocale', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('lang')
  })

  it('reports only resolved changes and disposes cleanly', async () => {
    const seen: Array<HostLocale | undefined> = []
    const stop = observeHostLocale((lang) => seen.push(lang))

    document.documentElement.setAttribute('lang', 'zh-CN')
    // The observer callback is delivered as a microtask.
    await Promise.resolve()
    expect(seen).toEqual(['zh'])

    // A rewrite to the same resolved language is not reported again.
    document.documentElement.setAttribute('lang', 'zh-TW')
    await Promise.resolve()
    expect(seen).toEqual(['zh'])

    document.documentElement.setAttribute('lang', 'en')
    await Promise.resolve()
    expect(seen).toEqual(['zh', 'en'])

    stop()
    document.documentElement.setAttribute('lang', 'zh')
    await Promise.resolve()
    expect(seen).toEqual(['zh', 'en'])
  })

  it('shares one observer across listeners and disconnects with the last', async () => {
    const a: Array<HostLocale | undefined> = []
    const b: Array<HostLocale | undefined> = []
    const stopA = observeHostLocale((l) => a.push(l))
    const stopB = observeHostLocale((l) => b.push(l))

    document.documentElement.setAttribute('lang', 'en-GB')
    await Promise.resolve()
    expect(a).toEqual(['en'])
    expect(b).toEqual(['en'])

    stopA()
    document.documentElement.setAttribute('lang', 'zh')
    await Promise.resolve()
    // B is still subscribed, so the shared observer must still be live.
    expect(b).toEqual(['en', 'zh'])
    expect(a).toEqual(['en'])
    stopB()
  })
})
