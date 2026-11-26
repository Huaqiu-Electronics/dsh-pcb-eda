import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  COPY, HARDWARE_UI_NS, describeHostError, installCopyLocale, issueText,
} from '../src/client/copy.js'
import { en, zh, type HardwareCopyKey } from '../src/client/locales.js'
import { DESTINATION_LABELS, DESTINATIONS } from '../src/client/model.js'

const HAN = /[\u4e00-\u9fff]/u

describe('zh_CN copy', () => {
  it('labels every destination', () => {
    expect(Object.keys(DESTINATION_LABELS)).toEqual([...DESTINATIONS])
    for (const destination of DESTINATIONS) {
      expect(DESTINATION_LABELS[destination].trim()).not.toBe('')
    }
    // PCB / BOM are the two names the product keeps in Latin script; the rest
    // must read as Chinese.
    const chinese = DESTINATIONS.filter(destination => HAN.test(DESTINATION_LABELS[destination]))
    expect(chinese).toEqual(['schematic', '3d', 'order'])
  })

  it('covers every error code the host route layer can put on the wire', () => {
    // The host is the other half of this contract. Reading its source keeps the
    // two lists from drifting silently: a code the host adds later and the UI
    // forgets shows up here, not as an English sentence in a Chinese panel.
    const routes = fileURLToPath(new URL('../../hardware-artifacts/src/routes.ts', import.meta.url))
    const service = fileURLToPath(new URL('../../hardware-artifacts/src/service.ts', import.meta.url))
    if (!existsSync(routes) || !existsSync(service)) return
    const serviceSource = readFileSync(service, 'utf8')

    // Discovery issues are a different vocabulary: they ride on a successful
    // result and are translated by `issueText`, not by the error envelope.
    const issueCodes = new Set(
      [...serviceSource.matchAll(/issue: \{ code: '([a-z][a-z-]+)'/gu)].map(match => match[1] as string),
    )
    expect(issueCodes.size).toBeGreaterThan(2)

    const codes = new Set<string>()
    for (const file of [routes, service]) {
      const source = readFileSync(file, 'utf8')
      for (const match of source.matchAll(/code: '([a-z][a-z-]+)'/gu)) codes.add(match[1] as string)
      // `errorWithCode(message, code, status)` — the service's own throws.
      for (const match of source.matchAll(/,\s*'([a-z][a-z-]+)',\s*\d{3}\)/gu)) codes.add(match[1] as string)
    }
    // Emitted by routes.ts when a thrown error carries no string code.
    codes.add('internal')

    expect(codes.size).toBeGreaterThan(15)
    const copyErrors = COPY.errors as Record<string, string | undefined>
    const missing = [...codes]
      .filter(code => !issueCodes.has(code) && copyErrors[code] === undefined)
      .sort()
    expect(missing).toEqual([])

    // Every discovery code must actually translate (i.e. not fall through to
    // the host's own English sentence).
    for (const code of issueCodes) {
      expect(issueText({ code, message: 'host sentence' }), code).not.toBe('host sentence')
    }
  })

  it('never leaves an error sentence blank or untranslated', () => {
    const copyErrors = COPY.errors as Record<string, string | undefined>
    for (const [code, sentence] of Object.entries(copyErrors)) {
      expect(sentence, code).toBeTruthy()
      expect(sentence, code).toMatch(HAN)
    }
  })

  it('names every empty viewer and says how to fill it', () => {
    expect(Object.keys(COPY.placeholder.title)).toEqual([...DESTINATIONS])
    expect(Object.keys(COPY.placeholder.guide)).toEqual([...DESTINATIONS])
    for (const destination of DESTINATIONS) {
      expect(COPY.placeholder.title[destination], destination).toMatch(HAN)
      // Every guide points at the agent, which is where this product's hardware
      // comes from. "Not available" alone is what this replaced.
      expect(COPY.placeholder.guide[destination], destination).toContain('智能体')
    }
    // BOM is generated, never authored: its copy says it follows the schematic.
    expect(COPY.placeholder.guide.bom).toContain('原理图')
    expect(COPY.placeholder.guide.bom).toContain('自动')
  })

  it('no longer says a viewer is simply unavailable', () => {
    // The placeholder pill used to read 不可用 in every stage.
    expect(JSON.stringify(COPY)).not.toContain('不可用')
  })
})

describe('host error translation', () => {
  it('keeps detail only where it is technical output', () => {
    expect(describeHostError('unauthorized', 'artifact is outside the authorized workspace'))
      .toBe(COPY.errors.unauthorized)
    expect(describeHostError('export-failed', 'kicad-cli exit 1'))
      .toBe(`${COPY.errors['export-failed']}（kicad-cli exit 1）`)
  })

  it('passes an unmodelled failure through untouched', () => {
    expect(describeHostError('some-future-code', 'host said this')).toBe('host said this')
    // No code at all (a transport-level failure): the message is all we have.
    expect(describeHostError(undefined, 'HTTP 502')).toBe('HTTP 502')
  })
})

describe('discovery issue translation', () => {
  it('derives the wording from the code, not the host sentence', () => {
    expect(issueText({ code: 'selection-required', message: '3 projects found; select one explicitly' }, { count: 3 }))
      .toBe(COPY.discovery.selectionRequiredCount(3))
    expect(issueText({ code: 'selection-required', message: 'select an artifact explicitly' }))
      .toBe(COPY.discovery.selectionRequiredArtifact)
    expect(issueText({ code: 'no-project', message: 'no .kicad_pro found under /w' }, { cwd: '/w' }))
      .toBe(COPY.discovery.noProject('/w'))
  })

  it('strips the host’s English tail where the useful part is the path', () => {
    expect(issueText({ code: 'missing-project', message: '/w/a.kicad_pro does not exist' }))
      .toBe(COPY.discovery.missingProject('/w/a.kicad_pro'))
  })

  it('shows the host sentence for an unknown issue code', () => {
    expect(issueText({ code: 'future-issue', message: 'something specific' })).toBe('something specific')
  })
})

describe('DSH locale binding', () => {
  it('ships a complete English dictionary for every Chinese key', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
    for (const [key, sentence] of Object.entries(en)) {
      expect(sentence, key).not.toMatch(HAN)
      expect(sentence.trim(), key).not.toBe('')
    }
  })

  it('ships no dictionary key that no copy reader uses', () => {
    // A key with no `translateCopy` reader is dead weight in both dictionaries.
    const readers = ['copy.ts', 'document/copy.ts']
      .map(name => readFileSync(fileURLToPath(new URL(`../src/client/${name}`, import.meta.url)), 'utf8'))
      .join('\n')
    const referenced = new Set(
      [...readers.matchAll(/translateCopy\(\s*'([^']+)'/gu)].map(match => match[1] as string),
    )
    expect(Object.keys(zh).filter(key => !referenced.has(key)).sort()).toEqual([])
  })

  it('follows the host language without a render site knowing about locales', () => {
    let locale: 'zh' | 'en' = 'zh'
    const registered: { readonly zh: typeof zh; readonly en: typeof en }[] = []
    const dispose = installCopyLocale({
      register: (_ns, dictionaries) => { registered.push(dictionaries); return () => {} },
      bind: (ns) => (key, params) => {
        expect(ns).toBe(HARDWARE_UI_NS)
        const template = (locale === 'en' ? en : zh)[key as HardwareCopyKey] ?? key
        return template.replace(/\{([A-Za-z][\w.-]*)\}/gu, (match, name: string) =>
          params?.[name] === undefined ? match : String(params[name]))
      },
    })
    try {
      expect(registered).toHaveLength(1)
      expect(COPY.product.name).toBe('硬件工程')
      locale = 'en'
      expect(COPY.product.name).toBe('Hardware Engineering')
      expect(DESTINATION_LABELS.schematic).toBe('Schematic')
      expect(COPY.discovery.selectionRequiredCount(3)).toBe('Found 3 hardware projects; select one explicitly.')
      expect(describeHostError('export-failed', 'kicad-cli exit 1'))
        .toBe('kicad-cli export failed. (kicad-cli exit 1)')
    } finally {
      dispose()
    }
    expect(COPY.product.name).toBe('硬件工程')
  })
})
