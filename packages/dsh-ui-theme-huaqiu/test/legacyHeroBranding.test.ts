// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { installLegacyHeroBranding } from '../src/client/legacyHeroBranding'

describe('installLegacyHeroBranding', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  it('brands the stock hero and restores it when disposed', () => {
    document.body.innerHTML = '<div><span>探索未至之境</span><span>预览版</span></div>'

    const dispose = installLegacyHeroBranding(() => '电子设计智能体平台')
    const [title, badge] = document.querySelectorAll('span')

    expect(title?.textContent).toBe('电子设计智能体平台')
    expect(badge?.style.display).toBe('none')

    dispose()

    expect(title?.textContent).toBe('探索未至之境')
    expect(badge?.style.display).toBe('')
  })

  it('brands hero markup inserted after installation', async () => {
    const dispose = installLegacyHeroBranding(() => 'Electronic Design Agent Platform')
    document.body.innerHTML = '<div><span>Into the Unknown</span><span>Preview</span></div>'

    await Promise.resolve()

    const [title, badge] = document.querySelectorAll('span')
    expect(title?.textContent).toBe('Electronic Design Agent Platform')
    expect(badge?.style.display).toBe('none')
    dispose()
  })
})
