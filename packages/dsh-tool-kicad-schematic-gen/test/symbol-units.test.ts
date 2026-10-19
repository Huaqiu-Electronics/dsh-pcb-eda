import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeCommonUnits } from '../src/schematic/symbol-units.ts'

test('normalization preserves exact graphics and pins and is idempotent', () => {
  const text = '(symbol "SW" (symbol "SW_0_0" (rectangle (start 0 0)(end 1 1))) (symbol "SW_0_1" (pin passive line (number "1"))))'
  const normalized = normalizeCommonUnits(text)
  assert.equal(normalized, text.replace('SW_0_0', 'SW_1_0').replace('SW_0_1', 'SW_1_1'))
  assert.equal(normalizeCommonUnits(normalized), normalized)
  assert.equal(normalizeCommonUnits('(symbol SW (symbol SW_0_1 (pin passive line)))'), '(symbol SW (symbol "SW_1_1" (pin passive line)))')
})

test('inheritance, mixed units, alternate bodies, empty symbols and unexpected names remain unchanged', () => {
  for (const text of [
    '(symbol "SW" (extends "Parent") (symbol "SW_0_1" (pin passive line)))',
    '(symbol "SW" (symbol "SW_0_1" (pin passive line)) (symbol "SW_1_1"))',
    '(symbol "SW" (symbol "SW_0_2" (pin passive line)))',
    '(symbol "SW" (symbol "SW_0_1" (rectangle (start 0 0)(end 1 1))))',
    '(symbol "SW" (symbol "Wrong_0_1" (pin passive line)))',
  ]) assert.equal(normalizeCommonUnits(text), text)
})
