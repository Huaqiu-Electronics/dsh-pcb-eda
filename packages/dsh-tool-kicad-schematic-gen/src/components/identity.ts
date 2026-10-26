/** Parse the current manufacturer_id/MPN contract. */
export function partIdentity(args: Record<string, unknown>) {
  if ('mfgId' in args) throw new Error('Unsupported parameter mfgId; use manufacturer_id')
  const id = args.manufacturer_id
  if (typeof id !== 'string' || !/^\d{1,20}$/.test(id)) throw new Error('manufacturer_id must contain 1 to 20 digits')
  if (typeof args.mpn !== 'string' || !args.mpn.trim() || args.mpn.length > 120) throw new Error('mpn must contain 1 to 120 characters')
  return { mfgId: id, mpn: args.mpn.trim() }
}
