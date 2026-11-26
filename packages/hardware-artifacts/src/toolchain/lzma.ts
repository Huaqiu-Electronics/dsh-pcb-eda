/**
 * LZMA (ZIP compression method 14) decoder.
 *
 * The HuaQiu KiCad distribution is ~84 % LZMA: 83 548 of its 99 460 entries use
 * method 14. Node's zlib has no LZMA, and the alternative — a native addon —
 * cannot be rebuilt for every Electron target the desktop app ships. So the
 * archive format the product actually serves decides this: without a decoder
 * here, the primary download button could never finish (§8.5 steps 3–4).
 *
 * This is the LZMA SDK algorithm (the `LzmaDecode` state machine) specialised to
 * what ZIP needs: raw LZMA1, properties from the entry header, and a known
 * output length. Only the decoder is implemented — the product never writes
 * archives.
 *
 * @module @huaqiu/hardware-artifacts/toolchain/lzma
 */

/** Probability model size (11-bit probabilities). */
const BIT_MODEL_TOTAL = 2048
const MOVE_BITS = 5
const TOP_VALUE = 0xFFFFFFFF
const NORMALIZE_THRESHOLD = 0x01000000

const NUM_STATES = 12
const NUM_POS_BITS_MAX = 4
const NUM_POS_STATES_MAX = 1 << NUM_POS_BITS_MAX
const NUM_LEN_TO_POS_STATES = 4
const NUM_ALIGN_BITS = 4
const ALIGN_TABLE_SIZE = 1 << NUM_ALIGN_BITS
const START_POS_MODEL_INDEX = 4
const END_POS_MODEL_INDEX = 14
const NUM_FULL_DISTANCES = 1 << (END_POS_MODEL_INDEX / 2)
const MATCH_MIN_LEN = 2

/** LZMA1 properties as the ZIP entry header declares them. */
export interface LzmaProperties {
  /** Literal context bits. */
  readonly lc: number
  /** Literal position bits. */
  readonly lp: number
  /** Position state bits. */
  readonly pb: number
  /** Dictionary size in bytes. */
  readonly dictSize: number
}

/** A stream this decoder cannot read; never repaired, always refused. */
export class LzmaError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'LzmaError'
  }
}

/**
 * Parse the 5-byte LZMA1 property block ZIP stores after its 4-byte method
 * header.
 * @param bytes - property bytes (usually five).
 * @returns the decoded properties.
 */
export function parseLzmaProperties(bytes: Buffer): LzmaProperties {
  if (bytes.length < 5) throw new LzmaError('invalid-properties', 'LZMA properties are truncated')
  const first = bytes[0] as number
  const lc = first % 9
  const lp = Math.floor(first / 9) % 5
  const pb = Math.floor(first / 45)
  if (pb >= NUM_POS_BITS_MAX + 1 || lp > 4 || lc > 8) {
    throw new LzmaError('invalid-properties', `unsupported LZMA properties (lc=${String(lc)}, lp=${String(lp)}, pb=${String(pb)})`)
  }
  const dictSize = bytes.readUInt32LE(1)
  return { lc, lp, pb, dictSize }
}

/** Range decoder over the compressed bytes. */
class RangeDecoder {
  private range = TOP_VALUE
  private code = 0
  private cursor = 0

  constructor(private readonly input: Buffer) {
    if (input.length === 0 || input[0] !== 0) {
      throw new LzmaError('invalid-stream', 'LZMA stream does not begin with a zero byte')
    }
    for (let index = 0; index < 5; index += 1) {
      const byte = this.readByte()
      this.code = ((this.code * 256) + byte) % 0x100000000
    }
  }

  private readByte(): number {
    const value = this.input[this.cursor]
    if (value === undefined) {
      // A truncated stream reads as zeros, exactly as the SDK's stream does;
      // the output length check is what turns truncation into an error.
      this.cursor += 1
      return 0
    }
    this.cursor += 1
    return value
  }

  /**
   * Normalise the range at the *end* of a decode step.
   *
   * The timing matters: `LzmaDecode` scales right after the range update, so
   * the next step always starts with a range of at least 2^24. Normalising at
   * the start instead leaves the *previous* step's value in place, and the
   * `range / 2` of an unmodelled bit then rounds away half a bit that the
   * reference implementation would have kept. That single rounding is enough to
   * desynchronise a real stream after a few hundred symbols — this decoder did
   * exactly that until the normalisation moved here.
   */
  private normalize(): void {
    if (this.range < NORMALIZE_THRESHOLD) {
      // Doubles keep the unsigned 32-bit range exact; `<<` would coerce to int32.
      this.range = (this.range * 256) % 0x100000000
      this.code = ((this.code * 256) + this.readByte()) % 0x100000000
    }
  }

  /** Decode one modelled bit. */
  decodeBit(probs: Uint16Array, index: number): number {
    const prob = probs[index] as number
    const bound = Math.floor(this.range / 2048) * prob
    let bit: number
    if (this.code < bound) {
      this.range = bound
      probs[index] = prob + ((BIT_MODEL_TOTAL - prob) >> MOVE_BITS)
      bit = 0
    } else {
      this.range -= bound
      this.code -= bound
      probs[index] = prob - (prob >> MOVE_BITS)
      bit = 1
    }
    this.normalize()
    return bit
  }

  /** Decode one unmodelled bit. */
  decodeDirectBit(): number {
    this.range = Math.floor(this.range / 2)
    let bit = 0
    if (this.code >= this.range) {
      this.code -= this.range
      bit = 1
    }
    this.normalize()
    return bit
  }

  /** Decode `count` unmodelled bits, most significant first. */
  decodeDirectBits(count: number): number {
    let result = 0
    for (let index = 0; index < count; index += 1) {
      result = result * 2 + this.decodeDirectBit()
    }
    return result
  }
}

/** One length-coder triple (low/mid/high trees behind two choices). */
class LengthDecoder {
  private readonly choice = new Uint16Array(1)
  private readonly choice2 = new Uint16Array(1)
  private readonly low = new Uint16Array(NUM_POS_STATES_MAX * 8)
  private readonly mid = new Uint16Array(NUM_POS_STATES_MAX * 8)
  private readonly high = new Uint16Array(256)

  constructor() {
    this.reset()
  }

  reset(): void {
    for (const table of [this.choice, this.choice2, this.low, this.mid, this.high]) {
      table.fill(BIT_MODEL_TOTAL >> 1)
    }
  }

  /** Decode one length symbol (0…273). */
  decode(decoder: RangeDecoder, posState: number): number {
    if (decoder.decodeBit(this.choice, 0) === 0) {
      return this.tree(decoder, this.low, posState * 8, 3)
    }
    if (decoder.decodeBit(this.choice2, 0) === 0) {
      return 8 + this.tree(decoder, this.mid, posState * 8, 3)
    }
    return 16 + this.tree(decoder, this.high, 0, 8)
  }

  private tree(decoder: RangeDecoder, probs: Uint16Array, base: number, bits: number): number {
    let m = 1
    for (let index = 0; index < bits; index += 1) {
      m = (m << 1) + decoder.decodeBit(probs, base + m)
    }
    return m - (1 << bits)
  }
}

/**
 * Decode one raw LZMA1 stream into exactly `outputSize` bytes.
 * @param compressed - stream bytes after the ZIP method header and properties.
 * @param properties - parsed LZMA1 properties.
 * @param outputSize - uncompressed length the central directory declared.
 * @returns the decompressed bytes.
 */
export function decodeLzma(compressed: Buffer, properties: LzmaProperties, outputSize: number): Buffer {
  const { lc, lp, pb } = properties
  const decoder = new RangeDecoder(compressed)
  const literalProbs = new Uint16Array(0x300 * (1 << (lc + lp)))
  const isMatch = new Uint16Array(NUM_STATES * NUM_POS_STATES_MAX)
  const isRep = new Uint16Array(NUM_STATES)
  const isRepG0 = new Uint16Array(NUM_STATES)
  const isRepG1 = new Uint16Array(NUM_STATES)
  const isRepG2 = new Uint16Array(NUM_STATES)
  const isRep0Long = new Uint16Array(NUM_STATES * NUM_POS_STATES_MAX)
  const posSlot = new Uint16Array(NUM_LEN_TO_POS_STATES * 64)
  const specPos = new Uint16Array(NUM_FULL_DISTANCES - END_POS_MODEL_INDEX)
  const align = new Uint16Array(ALIGN_TABLE_SIZE)
  for (const table of [literalProbs, isMatch, isRep, isRepG0, isRepG1, isRepG2, isRep0Long, posSlot, specPos, align]) {
    table.fill(BIT_MODEL_TOTAL >> 1)
  }
  const lenDecoder = new LengthDecoder()
  const repLenDecoder = new LengthDecoder()

  const output = Buffer.alloc(outputSize)
  const posStateMask = (1 << pb) - 1
  const literalPosMask = (1 << lp) - 1

  let state = 0
  let rep0 = 0
  let rep1 = 0
  let rep2 = 0
  let rep3 = 0
  let pos = 0

  const isMatchIndex = (state_: number, posState: number): number => state_ * NUM_POS_STATES_MAX + posState

  const decodeLiteral = (): void => {
    const prevByte = pos > 0 ? (output[pos - 1] as number) : 0
    const literalState = (((pos & literalPosMask) << lc) + (prevByte >> (8 - lc))) * 0x300
    let symbol = 1
    if (state >= 7) {
      // A literal in a match state is coded against the byte at the match
      // distance, which narrows the probability context per decoded bit.
      const matchByte = output[pos - rep0 - 1]
      if (matchByte === undefined) throw new LzmaError('invalid-stream', `literal match distance is out of range at pos ${String(pos)}`)
      let match = matchByte
      do {
        const matchBit = (match >> 7) & 1
        match = (match << 1) & 0xFF
        const bit = decoder.decodeBit(literalProbs, literalState + ((1 + matchBit) << 8) + symbol)
        symbol = (symbol << 1) | bit
        if (matchBit !== bit) break
      } while (symbol < 0x100)
    }
    while (symbol < 0x100) {
      symbol = (symbol << 1) | decoder.decodeBit(literalProbs, literalState + symbol)
    }
    output[pos] = symbol & 0xFF
    pos += 1
    state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6
  }

  /**
   * Decode the distance of a new match.
   *
   * Distances are coded in three bands: slots 0–3 are the distance itself,
   * slots 4–13 use a reverse bit tree whose base depends on the slot, and
   * slots 14+ use unmodelled "direct" bits plus the 4-bit align tree. The align
   * tree is reverse-decoded from index 1 — starting at 16 reads a probability
   * that belongs to another model.
   */
  const decodeDistance = (length: number): number => {
    const lenToPosState = length - MATCH_MIN_LEN < NUM_LEN_TO_POS_STATES ? length - MATCH_MIN_LEN : NUM_LEN_TO_POS_STATES - 1
    const base = lenToPosState * 64
    let m = 1
    for (let index = 0; index < 6; index += 1) m = (m << 1) + decoder.decodeBit(posSlot, base + m)
    const slot = m - 64
    if (slot < START_POS_MODEL_INDEX) return slot
    const directBits = (slot >> 1) - 1
    let distance = (2 | (slot & 1)) * (1 << directBits)
    if (slot < END_POS_MODEL_INDEX) {
      return distance + reverseTree(specPos, distance - slot - 1, directBits)
    }
    distance += decoder.decodeDirectBits(directBits - NUM_ALIGN_BITS) * ALIGN_TABLE_SIZE
    return distance + reverseTree(align, 0, NUM_ALIGN_BITS)
  }

  /** Reverse bit-tree decode: the first decoded bit is the least significant. */
  const reverseTree = (probs: Uint16Array, base: number, bits: number): number => {
    let m = 1
    let symbol = 0
    for (let index = 0; index < bits; index += 1) {
      const bit = decoder.decodeBit(probs, base + m)
      m = (m << 1) | bit
      symbol |= bit << index
    }
    return symbol
  }

  while (pos < outputSize) {
    const posState = pos & posStateMask
    if (decoder.decodeBit(isMatch, isMatchIndex(state, posState)) === 0) {
      decodeLiteral()
      continue
    }
    let length: number
    if (decoder.decodeBit(isRep, state) === 0) {
      // A new match: distances shift down the rep chain, then the distance
      // itself is coded with a model selected by the match length.
      rep3 = rep2
      rep2 = rep1
      rep1 = rep0
      length = lenDecoder.decode(decoder, posState) + MATCH_MIN_LEN
      state = state < 7 ? 7 : 10
      rep0 = decodeDistance(length)
    } else {
      if (decoder.decodeBit(isRepG0, state) === 0) {
        if (decoder.decodeBit(isRep0Long, isMatchIndex(state, posState)) === 0) {
          // A "short rep": one byte at the current distance.
          state = state < 7 ? 9 : 11
          const source = output[pos - rep0 - 1]
          if (source === undefined) throw new LzmaError('invalid-stream', `short rep distance is out of range at pos ${String(pos)}`)
          output[pos] = source
                pos += 1
          continue
        }
      } else {
        // A repeated distance: pick one of the three older entries and promote it.
        let distance: number
        if (decoder.decodeBit(isRepG1, state) === 0) {
          distance = rep1
        } else {
          if (decoder.decodeBit(isRepG2, state) === 0) {
            distance = rep2
          } else {
            distance = rep3
            rep3 = rep2
          }
          rep2 = rep1
        }
        rep1 = rep0
        rep0 = distance
      }
      length = repLenDecoder.decode(decoder, posState) + MATCH_MIN_LEN
      state = state < 7 ? 8 : 11
    }
    // Copy the match byte by byte: LZMA allows overlapping copies, so the output
    // may be both source and destination.
    for (let index = 0; index < length && pos < outputSize; index += 1) {
      const source = output[pos - rep0 - 1]
      if (source === undefined) throw new LzmaError('invalid-stream', `match distance is out of range at pos ${String(pos)} (rep0 ${String(rep0)})`)
      output[pos] = source
      pos += 1
    }
  }
  return output
}

/** Size of the method-14 header ZIP puts before its LZMA properties. */
export const LZMA_ZIP_HEADER_BYTES = 4

/**
 * Read an entry's LZMA properties out of its data header.
 * @param header - the first bytes of the entry data.
 * @returns the properties and the number of bytes the header consumed.
 */
export function readZipLzmaHeader(header: Buffer): { properties: LzmaProperties; consumed: number } {
  if (header.length < LZMA_ZIP_HEADER_BYTES + 5) {
    throw new LzmaError('invalid-stream', 'LZMA entry header is truncated')
  }
  const propertiesSize = header.readUInt16LE(2)
  if (propertiesSize < 5 || propertiesSize > 64) {
    throw new LzmaError('invalid-stream', `LZMA properties size ${String(propertiesSize)} is not supported`)
  }
  if (header.length < LZMA_ZIP_HEADER_BYTES + propertiesSize) {
    throw new LzmaError('invalid-stream', 'LZMA properties are truncated')
  }
  return {
    properties: parseLzmaProperties(header.subarray(LZMA_ZIP_HEADER_BYTES, LZMA_ZIP_HEADER_BYTES + propertiesSize)),
    consumed: LZMA_ZIP_HEADER_BYTES + propertiesSize,
  }
}
