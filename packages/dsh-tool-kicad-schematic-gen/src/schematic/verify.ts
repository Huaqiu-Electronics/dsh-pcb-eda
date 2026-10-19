/** Run KiCad's own netlist and ERC checks and return bounded, structured findings. */
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { runProcess } from './preview.ts'
import { children, parse, required, value, type Form } from './sexpr.ts'

/** One intended symbol pin and its named KiCad net. */
export interface ExpectedPin {
  reference: string
  pin: string
  net: string
}

/** Limits for local KiCad CLI verification. */
export interface VerificationConfig {
  kicadCliPath: string
  verificationTimeoutMs: number
  maxVerificationBytes: number
  maxVerificationItems: number
}

type KiCadRunner = (
  file: string, args: readonly string[], signal: AbortSignal, timeoutMs: number,
) => Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>

interface NetNode { reference: string; pin: string; pinName: string | null; pinType: string | null }
interface Net { name: string; nodes: NetNode[] }

/** Summary returned to the model; total counts include entries omitted by output limits. */
export interface VerificationResult {
  netCount: number
  nets: Array<{ name: string; nodeCount: number; nodes: NetNode[] }>
  netsTruncated: boolean
  mismatchCount: number
  mismatches: Array<{ reference: string; pin: string; expectedNet: string; actualNet: string | null }>
  mismatchesTruncated: boolean
  erc: {
    errors: number
    warnings: number
    exclusions: number
    ignoredChecks: string[]
    violations: Array<{ sheet: string; severity: string; type: string; description: string }>
    violationsTruncated: boolean
  }
}

/** Netlist-only result for workflows that do not request ERC. */
export type NetlistVerificationResult = Omit<VerificationResult, 'erc'>

function optionalValue(form: Form, head: string): string | null {
  const child = children(form, head)
  return child.length === 0 ? null : value(required(form, head))
}

/** Parse the canonical KiCad s-expression netlist rather than schematic wire geometry. */
export function parseNetlist(text: string): Net[] {
  const root = parse(text)
  if (root.head !== 'export') throw new Error('KiCad netlist has no export root')
  return children(required(root, 'nets'), 'net').map(net => ({
    name: value(required(net, 'name')),
    nodes: children(net, 'node').map(node => ({
      reference: value(required(node, 'ref')),
      pin: value(required(node, 'pin')),
      pinName: optionalValue(node, 'pinfunction'),
      pinType: optionalValue(node, 'pintype'),
    })),
  }))
}

function object(input: unknown, name: string): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error(`${name} is not an object`)
  return input as Record<string, unknown>
}

function string(input: unknown, name: string): string {
  if (typeof input !== 'string') throw new Error(`${name} is not a string`)
  return input
}

function entries(input: unknown, name: string): unknown[] {
  if (!Array.isArray(input)) throw new Error(`${name} is not an array`)
  return input as unknown[]
}

function parseErc(text: string): VerificationResult['erc'] {
  const root = object(JSON.parse(text) as unknown, 'KiCad ERC report')
  const sheets = entries(root.sheets, 'KiCad ERC sheets')
  const ignoredChecks = entries(root.ignored_checks, 'KiCad ignored checks')
    .map(item => string(object(item, 'KiCad ignored check').key, 'KiCad ignored check key'))
  const violations: VerificationResult['erc']['violations'] = []
  let errors = 0; let warnings = 0; let exclusions = 0
  for (const sheetValue of sheets) {
    const sheet = object(sheetValue, 'KiCad ERC sheet')
    const path = string(sheet.path, 'KiCad ERC sheet path')
    for (const violationValue of entries(sheet.violations, 'KiCad ERC violations')) {
      const violation = object(violationValue, 'KiCad ERC violation')
      const severity = string(violation.severity, 'KiCad ERC severity')
      if (severity === 'error') errors++
      else if (severity === 'warning') warnings++
      else if (severity === 'exclusion') exclusions++
      else throw new Error(`KiCad ERC reported unknown severity: ${severity}`)
      violations.push({
        sheet: path, severity,
        type: string(violation.type, 'KiCad ERC violation type'),
        description: string(violation.description, 'KiCad ERC description'),
      })
    }
  }
  return { errors, warnings, exclusions, ignoredChecks, violations, violationsTruncated: false }
}

function summarizeNetlist(nets: Net[], expectedPins: ExpectedPin[], limit: number): NetlistVerificationResult {
  const pinNets = new Map<string, string>()
  for (const net of nets) {
    for (const node of net.nodes) {
      const key = `${node.reference}\0${node.pin}`
      if (pinNets.has(key)) throw new Error(`KiCad netlist repeats pin ${node.reference}:${node.pin}`)
      pinNets.set(key, net.name)
    }
  }
  const allMismatches = expectedPins.flatMap(item => {
    const actualNet = pinNets.get(`${item.reference}\0${item.pin}`) ?? null
    return actualNet === item.net ? [] : [{ reference: item.reference, pin: item.pin,
      expectedNet: item.net, actualNet }]
  })
  const shownNets: VerificationResult['nets'] = []
  let remaining = limit
  for (const net of nets) {
    if (remaining === 0) break
    remaining--
    const nodes = net.nodes.slice(0, remaining)
    shownNets.push({ name: net.name, nodeCount: net.nodes.length, nodes })
    remaining -= nodes.length
  }
  const netsTruncated = shownNets.length < nets.length
    || shownNets.some(net => net.nodes.length < net.nodeCount)
  return {
    netCount: nets.length, nets: shownNets, netsTruncated,
    mismatchCount: allMismatches.length, mismatches: allMismatches.slice(0, limit),
    mismatchesTruncated: allMismatches.length > limit,
  }
}

function summarize(nets: Net[], expectedPins: ExpectedPin[], erc: VerificationResult['erc'], limit: number): VerificationResult {
  return { ...summarizeNetlist(nets, expectedPins, limit),
    erc: { ...erc, violations: erc.violations.slice(0, limit),
      violationsTruncated: erc.violations.length > limit } }
}

async function boundedFile(path: string, maxBytes: number): Promise<string> {
  const info = await stat(path)
  if (info.size > maxBytes) throw new Error(`KiCad verification output exceeds ${maxBytes} bytes`)
  const bytes = await readFile(path)
  if (bytes.byteLength > maxBytes) throw new Error(`KiCad verification output exceeds ${maxBytes} bytes`)
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

async function runKiCad(
  rootPath: string, label: string, args: readonly string[], config: VerificationConfig,
  signal: AbortSignal, runner: KiCadRunner,
): Promise<void> {
  let result: Awaited<ReturnType<KiCadRunner>>
  try {
    result = await runner(config.kicadCliPath, args, signal, config.verificationTimeoutMs)
  } catch (error) {
    if (signal.aborted) throw error
    throw new Error(`KiCad ${label} could not start for ${rootPath} using ${config.kicadCliPath}: `
      + `${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  if (result.timedOut || result.exitCode !== 0) {
    const facts = [
      result.timedOut ? `timed out after ${config.verificationTimeoutMs} ms` : undefined,
      result.exitCode !== 0 ? `exit code ${result.exitCode}` : undefined,
    ].filter((fact): fact is string => fact !== undefined)
    const raw = (result.stderr || result.stdout).trim()
    const excerpt = raw.length > 2000 ? `[output truncated] ${raw.slice(-2000)}` : raw
    throw new Error(`KiCad ${label} failed for ${rootPath}: ${facts.join('; ')}. `
      + (excerpt || 'KiCad produced no diagnostic output.'))
  }
}

/** Export one netlist, compare expected pins, and return the full text for workspace publication. */
export async function verifyNetlist(
  rootPath: string, expectedPins: ExpectedPin[], config: VerificationConfig, signal: AbortSignal,
  runner: KiCadRunner = runProcess,
): Promise<{ summary: NetlistVerificationResult; netlistText: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-kicad-verify-'))
  const netlistPath = join(directory, 'netlist.net')
  try {
    await runKiCad(rootPath, 'netlist export',
      ['sch', 'export', 'netlist', '--format', 'kicadsexpr', '--output', netlistPath, rootPath],
      config, signal, runner)
    const netlistText = await boundedFile(netlistPath, config.maxVerificationBytes)
    return { summary: summarizeNetlist(parseNetlist(netlistText), expectedPins, config.maxVerificationItems), netlistText }
  } finally {
    if (dirname(resolve(directory)) !== resolve(tmpdir())) throw new Error('KiCad verification temp directory escaped')
    await rm(directory, { recursive: true, force: true })
  }
}

/** Run read-only netlist and ERC checks and discard temporary CLI output after parsing. */
export async function verifySchematic(
  rootPath: string, expectedPins: ExpectedPin[], config: VerificationConfig, signal: AbortSignal,
  runner: KiCadRunner = runProcess,
): Promise<VerificationResult> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-kicad-verify-'))
  const netlistPath = join(directory, 'netlist.net')
  const ercPath = join(directory, 'erc.json')
  try {
    await runKiCad(rootPath, 'netlist export',
      ['sch', 'export', 'netlist', '--format', 'kicadsexpr', '--output', netlistPath, rootPath],
      config, signal, runner)
    await runKiCad(rootPath, 'ERC',
      ['sch', 'erc', '--format', 'json', '--severity-all', '--output', ercPath, rootPath],
      config, signal, runner)
    const [netlist, erc] = await Promise.all([
      boundedFile(netlistPath, config.maxVerificationBytes),
      boundedFile(ercPath, config.maxVerificationBytes),
    ])
    return summarize(parseNetlist(netlist), expectedPins, parseErc(erc), config.maxVerificationItems)
  } finally {
    if (dirname(resolve(directory)) !== resolve(tmpdir())) throw new Error('KiCad verification temp directory escaped')
    await rm(directory, { recursive: true, force: true })
  }
}
