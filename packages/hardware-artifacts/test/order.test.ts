/**
 * Fabrication packaging and order submission.
 *
 * These tests exercise the contract the KiCad place-order action speaks:
 * derived board facts, the two CSV tables the assembly endpoint parses, the
 * multipart bodies, and the final page URL KiCad loads (which the host instead
 * hands to the default browser).
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HardwareArtifactService, groupBomRows, parseCsv } from '../src/service.js'
import {
  orderBomCsv, orderBomRows, orderIdsFromUrl, parsePositions,
  pcbOrderForm, pcbOrderUrl, positionsCsv, readBoardFacts, smtOrderForm, smtOrderUrl,
  smtOrderUrlFromBackend, snapHoleTier, snapThickness, snapTraceTier,
} from '../src/order.js'

/** A shape taken from a real Huaqiu login token (uuid + machine suffix). */
const TOKEN = '7047b925-d38b-5cb8-88bd-22a2a9d928fc-6b02f368'

let root: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'hw-order-')))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function write(relative: string, content = ''): string {
  const path = join(root, relative)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content, 'utf8')
  return path
}

const BOARD = `(kicad_pcb (version 20240108) (generator "pcbnew")
  (general (thickness 1.6))
  (layers
    (0 "F.Cu" signal)
    (31 "B.Cu" signal)
    (32 "B.Adhes" user "B.Adhesive")
  )
  (setup
    (stackup
      (layer "F.SilkS" (type "Top Silk Screen"))
      (layer "F.Mask" (type "Top Solder Mask") (thickness 0.01))
      (layer "F.Cu" (type "copper") (thickness 0.035))
      (layer "dielectric 1" (type "core") (thickness 1.51))
      (layer "B.Cu" (type "copper") (thickness 0.035))
    )
  )
  (gr_rect (start 100 100) (end 160 140) (stroke (width 0.05)) (fill none) (layer "Edge.Cuts"))
  (segment (start 100.5 100.5) (end 110 100.5) (width 0.25) (layer "F.Cu") (net 0))
  (via (at 120 120) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 0))
)
`

const POSITIONS = [
  'Ref,Val,Package,PosX,PosY,Rot,Side',
  'C1,100n,C_0402,10.5,20.25,90,top',
  'R1,10k,R_0603,30,40,180,bottom',
  '',
].join('\n')

const BOM_CSV = [
  '"Refs","Value","Footprint","Qty","DNP"',
  '"R1","10k","Resistor_SMD:R_0603_1608Metric","1",""',
  '"R2","10k","Resistor_SMD:R_0603_1608Metric","1",""',
  '',
].join('\n')

describe('board facts', () => {
  it('reads layers, outline, thickness, min track, min drill and copper weight', () => {
    const facts = readBoardFacts(BOARD)
    expect(facts.layers).toBe(2)
    expect(facts.widthMm).toBe(60)
    expect(facts.heightMm).toBe(40)
    expect(facts.thicknessMm).toBe(1.6)
    expect(facts.minTrackMm).toBe(0.25)
    expect(facts.minViaDrillMm).toBe(0.3)
    expect(facts.outerOz).toBe(1)
    expect(facts.innerOz).toBeUndefined()
  })

  it('rejects a document that is not a board', () => {
    expect(() => readBoardFacts('(kicad_sch (version 20231120))')).toThrow(/not a kicad_pcb/u)
  })

  it('keeps a renamed copper layer as an alias of its canonical name', () => {
    // `(0 "F.Cu" power "top_copper")` — KiCad plots `top_copper` into the
    // filename, so the package validator needs the mapping back.
    const renamed = BOARD.replace('(0 "F.Cu" signal)', '(0 "F.Cu" power "top_copper")')
    expect(readBoardFacts(renamed).copperAliases).toEqual({ top_copper: 'F_Cu' })
    expect(readBoardFacts(renamed).layers).toBe(2)
  })

  it('reports no aliases for a board keeping the default layer names', () => {
    // `(32 "B.Adhes" user "B.Adhesive")` renames a *non-copper* layer, which is
    // not the validator's problem, and no copper layer is renamed.
    expect(readBoardFacts(BOARD).copperAliases).toBeUndefined()
  })
})

describe('order form', () => {
  it('converts millimetres to the centimetre geometry the endpoint expects', () => {
    const form = pcbOrderForm(readBoardFacts(BOARD), { quantity: 20 })
    expect(form.blayer).toBe('2')
    expect(form.bwidth).toBe('6.00')
    expect(form.blength).toBe('4.00')
    expect(form.bcount).toBe('20')
    expect(form.bheight).toBe('1.6')
    expect(form.lineweight).toBe('10')
    expect(form.vias).toBe('0.3')
    expect(form.insidecopper).toBe('0')
    // The base/process/special/personalized blocks are all present, as the
    // endpoint validates the complete form.
    for (const key of ['plate_type', 'units', 'sidedirection', 'color', 'spray', 'review_file', 'paper', 'hq_pack']) {
      expect(form[key]).toBeTypeOf('string')
    }
  })

  it('snaps measurements onto the offered tiers', () => {
    expect(snapTraceTier(0.25)).toBe('10')
    expect(snapTraceTier(0.1)).toBe('4')
    expect(snapTraceTier(undefined)).toBe('6')
    expect(snapThickness(2, 1.58)).toBe('1.6')
    expect(snapThickness(4, 1.7)).toBe('1.6')
    expect(snapHoleTier(0.12, 1.6)).toBe('0.2')
    expect(snapHoleTier(undefined, 1.0)).toBe('0.15')
  })

  it('keeps the assembly form on the board form panel size', () => {
    const facts = readBoardFacts(BOARD)
    const form = smtOrderForm(facts, { bomFileName: 'demo-bom.csv', coordFileName: 'demo-positions.csv', materialTypes: 2 })
    const pcb = pcbOrderForm(facts)
    // The reference copies bheight and blength straight into the assembly form.
    expect(form.pcb_ban_height).toBe(pcb.bheight)
    expect(form.pcb_ban_width).toBe(pcb.blength)
    expect(form.bom_file_name).toBe('demo-bom.csv')
    expect(form.bom_material_type_number).toBe('2')
  })
})

describe('assembly tables', () => {
  it('converts kicad-cli positions into the endpoint table', () => {
    const rows = parsePositions(POSITIONS)
    expect(rows).toEqual([
      { designator: 'C1', footprint: 'C_0402', x: '10.5mm', y: '20.25mm', layer: 'T', rotation: '90', comment: '100n' },
      { designator: 'R1', footprint: 'R_0603', x: '30mm', y: '40mm', layer: 'B', rotation: '180', comment: '10k' },
    ])
    const csv = positionsCsv(rows)
    expect(csv.startsWith('\uFEFFDesignator,Footprint,PosX,PosY,Layer,Rotation,Comment\n')).toBe(true)
    expect(csv).toContain('C1,C_0402,10.5mm,20.25mm,T,90,100n')
  })

  it('groups positions by value and footprint, preferring a BOM MPN', () => {
    const bom = groupBomRows(parseCsv(BOM_CSV))
    const withMpn = bom.map(row => ({ ...row, fields: { ...row.fields, MPN: 'RC0603FR-0710KL' } }))
    const rows = orderBomRows(parsePositions(POSITIONS), withMpn)
    expect(rows).toHaveLength(2)
    const resistor = rows.find(row => row.designators.includes('R1'))
    expect(resistor).toMatchObject({
      mpn: 'RC0603FR-0710KL', description: '10k', footprint: 'Resistor_SMD:R_0603_1608Metric', quantity: 1,
    })
    // No BOM entry: the position data is kept rather than dropped.
    const capacitor = rows.find(row => row.designators.includes('C1'))
    expect(capacitor).toMatchObject({ mpn: '100n', footprint: 'C_0402' })
  })

  it('writes the assembly BOM header the endpoint parses', () => {
    const rows = orderBomRows(parsePositions(POSITIONS), groupBomRows(parseCsv(BOM_CSV)))
    const csv = orderBomCsv(rows)
    expect(csv.startsWith('\uFEFF序号,型号,规格参数,封装,品牌,位号,单机用量\n')).toBe(true)
    expect(csv.split('\n')[1]).toMatch(/^1,/)
  })
})

describe('order URLs', () => {
  it('extracts the ids from the redirect the backend returns', () => {
    expect(orderIdsFromUrl('https://www.hqpcb.com/mycenter/orders/pcb/quote?id=42&guid=ab-cd&tid=354'))
      .toEqual({ id: '42', guid: 'ab-cd' })
  })

  it('composes exactly the PCB page a KiCad order opens', () => {
    const orderUrl = pcbOrderUrl(
      'https://www.hqpcb.com',
      { id: '4679157', guid: '19c11d784808ff55b98a2bdb1edb6d91' },
      TOKEN,
    )
    expect(orderUrl).toBe(
      `https://www.hqpcb.com/mycenter/orders/pcb/quote?type=PCB&id=4679157`
      + `&guid=19c11d784808ff55b98a2bdb1edb6d91&tid=354&token=${TOKEN}`,
    )
    // No id means there is no page to open, not a page with empty parameters.
    expect(pcbOrderUrl('https://www.hqpcb.com', {}, TOKEN)).toBeUndefined()
  })

  it('composes exactly the assembly page, with source=bom', () => {
    const smt = smtOrderUrl('https://www.hqpcb.com', { id: '1309829474627354699' }, TOKEN)
    expect(smt).toBe(
      `https://www.hqpcb.com/mycenter/orders/smt/quote?id=1309829474627354699&source=bom&token=${TOKEN}`,
    )
  })

  it('falls back to the backend URL only when the response carries no order id', () => {
    expect(smtOrderUrl('https://www.hqpcb.com', {}, TOKEN)).toBeUndefined()
    expect(smtOrderUrlFromBackend('https://www.hqpcb.com/mycenter/orders/smt/quote?id=1', 'tok'))
      .toBe('https://www.hqpcb.com/mycenter/orders/smt/quote?id=1&token=tok&source=bom')
  })
})

// ---------------------------------------------------------------------------
// Service-level submission
// ---------------------------------------------------------------------------

interface Captured {
  url: string
  body: string
  contentType: string
  headers?: Readonly<Record<string, string>>
}

function serviceWithFakeCli(options: {
  token?: string
  /** Stands in for the signed-in Huaqiu session (`huaqiuAuth`). */
  session?: () => Promise<string | null>
  respond?: (url: string) => unknown
  capture?: Captured[]
  baseUrl?: string
  opened?: string[]
} = {}): { service: HardwareArtifactService; calls: string[][] } {
  const app = join(root, 'KiCad.app')
  const cli = write('KiCad.app/Contents/MacOS/kicad-cli', '')
  write('KiCad.app/Contents/MacOS/kicad', '')
  const calls: string[][] = []
  const service = new HardwareArtifactService({
    kicadRoot: app,
    probeVersion: () => '10.0.7',
    cacheRoot: join(root, '.cache'),
    ...(options.token === undefined ? {} : { accessToken: options.token }),
    ...(options.session === undefined ? {} : { authToken: options.session }),
    ...(options.baseUrl === undefined ? {} : { orderBaseUrl: options.baseUrl }),
    // A test must never start a real browser: the opener and the process
    // launcher are both fakes, and the URL is recorded instead.
    openExternal: (url) => {
      options.opened?.push(url)
      return { command: 'open', args: [url] }
    },
    spawnProcess: () => ({ pid: 4242 }),
    runCommand: async (_command, args) => {
      calls.push([...args])
      if (args[1] === 'export' && args[2] === 'gerbers') {
        const dir = args[args.indexOf('--output') + 1] ?? ''
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'main-F_Cu.gbr'), 'G04 front*\n')
        writeFileSync(join(dir, 'main-B_Cu.gbr'), 'G04 back*\n')
        writeFileSync(join(dir, 'main-Edge_Cuts.gbr'), 'G04 edge*\n')
      } else if (args[1] === 'export' && args[2] === 'drill') {
        const dir = args[args.indexOf('--output') + 1] ?? ''
        writeFileSync(join(dir, 'main.drl'), 'M48\n')
      } else if (args[1] === 'export' && args[2] === 'pos') {
        writeFileSync(args[args.indexOf('--output') + 1] ?? '', POSITIONS)
      } else if (args[0] === 'sch') {
        writeFileSync(args[args.indexOf('--output') + 1] ?? '', BOM_CSV)
      }
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
    },
    postOrder: async (url, init) => {
      options.capture?.push({
        url,
        body: init.body.toString('utf8'),
        contentType: init.contentType,
        ...(init.headers === undefined ? {} : { headers: init.headers }),
      })
      const payload = options.respond?.(url) ?? { url: 'https://www.hqpcb.com/mycenter/orders/pcb/quote?id=42&guid=ab' }
      return { status: 200, text: JSON.stringify(payload) }
    },
  })
  return { service, calls }
}

function project(): { board: string; schematic: string } {
  write('demo.kicad_pro', '{}')
  const schematic = write('demo.kicad_sch', '(kicad_sch (version 20231120))\n')
  const board = write('demo.kicad_pcb', BOARD)
  return { board, schematic }
}

describe('order submission', () => {
  it('packages gerbers and drill output into the upload archive', async () => {
    const { board, schematic } = project()
    const { service, calls } = serviceWithFakeCli()
    const prepared = await service.fabricate({ boardPath: board, schematicPath: schematic })
    expect(prepared.archive.zipName).toBe('demo.zip')
    expect(prepared.archive.files.map(file => file.name)).toEqual([
      'main-B_Cu.gbr', 'main-Edge_Cuts.gbr', 'main-F_Cu.gbr', 'main.drl',
    ])
    // A real zip starts with the local file header signature.
    expect(String.fromCharCode(...prepared.archiveData.subarray(0, 2))).toBe('PK')
    expect(prepared.assembly).toMatchObject({ positions: 2, bomLines: 2 })
    // Cached by revision: a second read must not run the exporter again.
    const before = calls.length
    await service.fabricate({ boardPath: board, schematicPath: schematic })
    expect(calls.length).toBe(before)
  })

  it('posts the PCB form and archive, then hands the page back unopened', async () => {
    const { board, schematic } = project()
    const capture: Captured[] = []
    const opened: string[] = []
    const { service } = serviceWithFakeCli({ capture, opened, token: 'tok' })
    const placed = await service.placeOrder({ kind: 'pcb', boardPath: board, schematicPath: schematic, quantity: 20 })
    expect(placed.responseUrl).toBe('https://www.hqpcb.com/mycenter/orders/pcb/quote?id=42&guid=ab')
    // The exact URL KiCad's PlaceOrderForPCB builds for its webview.
    expect(placed.orderUrl).toBe(
      'https://www.hqpcb.com/mycenter/orders/pcb/quote?type=PCB&id=42&guid=ab&tid=354&token=tok',
    )
    // The client opens the page in its own Browser tab; the host opening the OS
    // browser as well would show the same order twice.
    expect(placed.launched).toBe(false)
    expect(placed.status).toBe('ready')
    expect(opened).toEqual([])
    expect(capture).toHaveLength(1)
    const request = capture[0]
    expect(request?.url).toBe('https://www.eda.cn/openapi/api/hqpcb/External/fileQuote')
    expect(request?.contentType).toMatch(/^multipart\/form-data; boundary=/u)
    expect(request?.body).toContain('name="blayer"')
    expect(request?.body).toContain('name="bcount"\r\nContent-Type: text/plain\r\n\r\n20')
    expect(request?.body).toContain('name="file"; filename="demo.zip"')
    expect(request?.body).toContain('Content-Type: application/zip')
    // The PCB endpoint takes no authorization header in the reference client.
    expect(request?.headers).toBeUndefined()
  })

  it('refuses to order without a session and never contacts the endpoint', async () => {
    const { board, schematic } = project()
    const capture: Captured[] = []
    const { service } = serviceWithFakeCli({ capture })
    // Both kinds need the hqpcb token: it is the Huaqiu login token, and the
    // order page would otherwise open signed out.
    for (const kind of ['pcb', 'smt'] as const) {
      await expect(service.placeOrder({ kind, boardPath: board, schematicPath: schematic }))
        .rejects.toMatchObject({ code: 'unauthorized' })
    }
    expect(capture).toHaveLength(0)
  })

  it('uses the signed-in session token when no token is configured', async () => {
    const { board, schematic } = project()
    const opened: string[] = []
    const { service } = serviceWithFakeCli({ opened, session: async () => TOKEN })
    expect(await service.orderConfig()).toMatchObject({ hasToken: true, provider: 'huaqiu' })
    const placed = await service.placeOrder({ kind: 'pcb', boardPath: board, schematicPath: schematic })
    expect(placed.orderUrl?.endsWith(`&token=${TOKEN}`)).toBe(true)
    expect(opened).toEqual([])
  })

  it('treats a signed-out session as no token', async () => {
    const { service } = serviceWithFakeCli({ session: async () => null })
    expect(await service.orderConfig()).toMatchObject({ hasToken: false })
  })

  it('posts the three assembly files, the merged form and the token', async () => {
    const { board, schematic } = project()
    const capture: Captured[] = []
    const opened: string[] = []
    const { service } = serviceWithFakeCli({
      capture,
      opened,
      token: 'tok',
      respond: () => ({ result: { url: 'https://www.hqpcb.com/mycenter/orders/smt/quote?id=1309829474627354699' } }),
    })
    const placed = await service.placeOrder({ kind: 'smt', boardPath: board, schematicPath: schematic, quantity: 10 })
    expect(placed.responseUrl).toBe('https://www.hqpcb.com/mycenter/orders/smt/quote?id=1309829474627354699')
    // The assembly page the webview ends on: id, source=bom, token — the same
    // query the site shows, composed from the id the endpoint returned.
    expect(placed.orderUrl).toBe(
      'https://www.hqpcb.com/mycenter/orders/smt/quote?id=1309829474627354699&source=bom&token=tok',
    )
    expect(placed.launched).toBe(false)
    expect(opened).toEqual([])
    const request = capture[0]
    expect(request?.url).toBe('https://www.eda.cn/openapi/pcba/saveDfmTmpOrder')
    expect(request?.headers).toEqual({ authorization: 'tok' })
    for (const part of ['pcbFile', 'coordFile', 'bomFile']) {
      expect(request?.body).toContain(`name="${part}"`)
    }
    const parse = /name="reqParseVO"\r\n[^\r]*\r\n\r\n(.*)\r\n--/u.exec(request?.body ?? '')
    expect(parse).not.toBeNull()
    const form = JSON.parse(parse?.[1] ?? '{}') as { pcb_order?: { blayer?: string }, smt_order?: { number?: string } }
    expect(form.pcb_order?.blayer).toBe('2')
    expect(form.smt_order?.number).toBe('10')
  })

  it('opens the OS browser only when a caller explicitly asks for it', async () => {
    const { board, schematic } = project()
    const opened: string[] = []
    const { service } = serviceWithFakeCli({ opened, token: 'tok' })
    const placed = await service.placeOrder({
      kind: 'pcb', boardPath: board, schematicPath: schematic, launch: true,
    })
    expect(placed.launched).toBe(true)
    expect(placed.status).toBe('launched')
    expect(placed.orderUrl).toContain('/mycenter/orders/pcb/quote?')
    expect(opened).toEqual([placed.orderUrl])
  })

  it('opens only web URLs, and only loopback over plain HTTP', () => {
    const { service } = serviceWithFakeCli()
    expect(service.openOrderUrl('https://www.hqpcb.com/mycenter/orders/pcb/quote?id=1').command).toBe('open')
    expect(service.openOrderUrl('http://127.0.0.1:4010/order/abc').command).toBe('open')
    expect(() => service.openOrderUrl('javascript:alert(1)')).toThrow(/invalid-order-url|refusing/u)
    expect(() => service.openOrderUrl('file:///etc/hosts')).toThrow(/invalid-order-url|refusing/u)
    expect(() => service.openOrderUrl('http://example.com/order')).toThrow(/invalid-order-url|refusing/u)
    expect(() => service.openOrderUrl('https://user:pass@example.com/order')).toThrow(/invalid-order-url|refusing/u)
  })

  it('reports a rejected submission with the backend detail', async () => {
    const { board, schematic } = project()
    const { service } = serviceWithFakeCli({
      token: 'tok',
      respond: () => ({ code: 500, msg: 'login required' }),
    })
    await expect(service.placeOrder({ kind: 'pcb', boardPath: board, schematicPath: schematic }))
      .rejects.toMatchObject({ code: 'order-rejected' })
  })

  it('explains a missing KiCad installation instead of uploading', async () => {
    const { board } = project()
    const service = new HardwareArtifactService({ cacheRoot: join(root, '.cache'), postOrder: async () => ({ status: 200, text: '{}' }) })
    await expect(service.placeOrder({ kind: 'pcb', boardPath: board }))
      .rejects.toMatchObject({ code: 'not-configured' })
    expect(await service.orderConfig()).toMatchObject({ configured: false, provider: 'huaqiu' })
  })

  it('keeps the configured base URL for the submission target', async () => {
    const { board, schematic } = project()
    const capture: Captured[] = []
    const { service } = serviceWithFakeCli({ capture, baseUrl: 'http://127.0.0.1:9999/', token: 'tok' })
    await service.placeOrder({ kind: 'pcb', boardPath: board, schematicPath: schematic })
    expect(capture[0]?.url).toBe('http://127.0.0.1:9999/openapi/api/hqpcb/External/fileQuote')
  })
})
