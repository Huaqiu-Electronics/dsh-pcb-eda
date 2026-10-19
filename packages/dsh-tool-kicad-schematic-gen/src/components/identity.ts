/** Canonical identity; legacy direct callers may still use mfgId outside tool schemas. */
export function partIdentity(args: Record<string, unknown>) {
  const id = args.manufacturer_id ?? args.mfgId
  if (args.manufacturer_id !== undefined && args.mfgId !== undefined && args.manufacturer_id !== args.mfgId) {
    throw new Error('manufacturer_id and mfgId must identify the same manufacturer')
  }
  if (typeof id !== 'string' || !/^\d{1,20}$/.test(id)) throw new Error('manufacturer_id must contain 1 to 20 digits')
  if (typeof args.mpn !== 'string' || !args.mpn.trim() || args.mpn.length > 120) throw new Error('mpn must contain 1 to 120 characters')
  return { mfgId: id, mpn: args.mpn.trim() }
}
