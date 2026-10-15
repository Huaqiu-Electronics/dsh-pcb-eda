---
name: eda-part-search-supply-chain
metadata:
  category: part-search
  tool: get_hqsch_supply_chain
  operation: supply-chain
  description: >-
    Get supply-chain offers (vendor, stock, MOQ, lead time, price breaks,
    distributor URL) for one or more parts by manufacturer id + MPN. Batched.
---

# `get_hqsch_supply_chain` — Supply Chain Reference

Returns supply-chain offers (vendor, stock, MOQ, lead time, price breaks,
distributor URL) for one or more parts. Supports **batched** lookup — pass
an array of parts to fetch offers for several candidates at once.

## When to call

- Procurement / availability gating (e.g. "is this part buyable in the
  quantities I need?").
- Comparing candidates by stock / lead time before committing to one.
- A manufacturing-readiness playbook requires stock confirmation.

Call this **last** in the progressive workflow — after `search` →
`get_hqsch_part` → `get_hqsch_part_models`. Supply-chain data is the most
volatile field (stock and price mutate minute-to-minute), so fetching it
early just produces stale data.

Do **not** call this to discover parts — use `search_hqsch_parts` first.

## Parameters

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `parts` | `PartIdentifier[]` | **yes** | array of `{ manufacturer_id, mpn }` (min length 1) |

### `PartIdentifier`

| Field | Type | Description |
| --- | --- | --- |
| `manufacturer_id` | `string` | Huaqiu manufacturer id, from `search_hqsch_parts` |
| `mpn` | `string` | Manufacturer Part Number |

> Batch lookups are encouraged — one call with N parts is cheaper than N
> calls with one part each.

## Response

An array of `SupplyOffer` objects (one or more per input part — a part may
have offers from multiple distributors):

Optional fields are omitted when the distributor publishes no value.

| Field | Type | Description |
| --- | --- | --- |
| `manufacturerId` | `string` | echoed from the input |
| `mpn` | `string` | echoed from the input |
| `vendor` / `vendorName` | `string?` | distributor id / display name |
| `sku` | `string?` | distributor SKU |
| `stock` | `number?` | available units |
| `quantity` | `number?` | package / reel quantity |
| `moq` | `number?` | minimum order quantity |
| `leadTimeDays` | `number?` | factory lead time in days |
| `currency` | `string?` | offer currency hint |
| `priceBreaks` | `PriceBreak[]` | tiered pricing |
| `distributorUrl` | `string?` | buy / detail URL |
| `authorizedDealer` | `boolean?` | authorized distributor |
| `recommended` | `boolean?` | Huaqiu-recommended offer |

### `PriceBreak`

| Field | Type | Description |
| --- | --- | --- |
| `breakMin` | `number?` | minimum quantity for this tier |
| `breakMax` | `number \| null?` | maximum quantity (`null` = open-ended) |
| `prices` | `{ usd?, rmb?, cny?, cad?, eur?, aud?, jpy?, gbp? }` | unit price per currency (`null` when not quoted) |

## Example

### Batch lookup of two candidates

```json
{
  "parts": [
    { "manufacturer_id": "7189", "mpn": "STM32F103C8T6" },
    { "manufacturer_id": "7189", "mpn": "STM32F103CBT6" }
  ]
}
```

### Channel B — `client.parts.getSupplyChain`

```typescript
const offers = await client.parts.getSupplyChain([
  { manufacturerId: "7189", mpn: "STM32F103C8T6" },
  { manufacturerId: "7189", mpn: "STM32F103CBT6" },
]);
```

## Interpreting results

- **No offers returned for a part** → the part is catalogued but currently
  has no distributor stock. Don't treat this as an error; treat it as a
  signal to pick a different candidate or escalate to the user.
- **`stock` missing** → the distributor does not publish real-time stock;
  treat `leadTimeDays` as the availability signal instead.
- **`moq` missing** → no published minimum; assume 1 but confirm with the
  distributor URL before committing.
- **Currency** → read the price from `priceBreaks[].prices.<currency>`
  (domestic offers usually quote `rmb` / `cny`). When only some currencies
  are filled, say which one you reported.

## Caching & Freshness

- Both channels (DSH tool / `client.parts`) hit the Huaqiu API directly with
  no cache. Only the optional HQ Edge gateway caches supply-chain data
  (~1 minute, the shortest TTL in the capability).
- For a procurement-critical decision, call this once immediately before
  recording the decision — do not trust cached stock numbers from earlier
  in the conversation.

## Errors

| Error type | HTTP status | Meaning |
| --- | --- | --- |
| `InvalidRequest` | 400 | `parts` missing / empty / malformed |
| `PartNotFound` | 404 | one or more input parts do not exist (the error names the first offender) |
| `UpstreamError` | 502 | Huaqiu host unreachable |

A 404 here is recoverable — drop the offending part from the batch and
retry with the survivors, or re-run `search_hqsch_parts` for a fresh
candidate.

See the main [SKILL.md](../part-search.md) for the progressive workflow.
