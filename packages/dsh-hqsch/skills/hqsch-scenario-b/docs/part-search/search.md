---
name: eda-part-search-search
metadata:
  category: part-search
  tool: search_hqsch_parts
  operation: search
  description: >-
    Search electronic components by keyword. Returns paginated candidates with
    MPN, manufacturer, package, description, and EDA-model availability flags.
---

# `search_hqsch_parts` — Part Search Reference

Search electronic components / ICs / PCB parts by keyword. This is the
**entry point** of the part-search workflow — always start here, even if the
user gave an MPN, because Huaqiu manufacturer IDs (needed by the downstream
`get_hqsch_part` / `get_hqsch_part_models` / `get_hqsch_supply_chain` tools)
are only discoverable through a search hit.

## When to call

- The user provides a keyword, partial MPN, or functional description.
- A playbook needs candidate parts to evaluate against requirements.
- You need to discover the `manufacturerId` + `mpn` pair required by the
  detail / models / supply-chain tools.

Do **not** call this if you already hold a `(manufacturerId, mpn)` pair from
a previous search — go straight to `get_hqsch_part`.

## Parameters

| Name | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `query` | `string` | **yes** | — | Search keyword. Partial MPN, description, or package+value. Max 200 chars. Fuzzy. |
| `page` | `integer` | no | `1` | 1-based page index. |
| `page_size` | `integer` | no | `10` | Page size, 1–50. |
| `require_eda_model` | `boolean` | no | `true` | When true, only return parts with at least one EDA model. |
| `requirements` | `object` | no | — | Fine-grained model requirements (see below). |
| `language` | `"en"` \| `"zh"` | no | `"zh"` | Response language. |

### `requirements` sub-object

All optional booleans. When set to `true`, the search filters to parts that
have **at least** that model type.

| Field | Meaning |
| --- | --- |
| `symbol` | has a schematic symbol |
| `footprint` | has a PCB footprint |
| `model3d` | has a 3D model |
| `simulation` | has a simulation model |
| `supplier` | has supply-chain data |

For a real PCB design, set **both** `symbol: true` and `footprint: true`.

## Response

A `PartSearchPage` object:

| Field | Type | Description |
| --- | --- | --- |
| `page` | `integer` | current page (1-based) |
| `pageSize` | `integer` | page size used |
| `pages` | `integer` | total page count |
| `total` | `integer` | total result count |
| `items` | `PartSearchHit[]` | candidate parts on this page |

### `PartSearchHit`

| Field | Type | Description |
| --- | --- | --- |
| `mpn` | `string` | Manufacturer Part Number — pass to `get_hqsch_part` |
| `manufacturer` | `{ id, name }` | `id` is the Huaqiu manufacturer id — pass to `get_hqsch_part` |
| `package` | `string` \| `null` | package code (e.g. `LQFP48`) |
| `description` | `string` \| `null` | localized short description |
| `hasSymbol` | `boolean` | schematic symbol available |
| `hasFootprint` | `boolean` | PCB footprint available |
| `has3dModel` | `boolean` | 3D model available |
| `hasSimulationModel` | `boolean` | simulation model available |

> **Note:** `manufacturer.id` + `mpn` together form the canonical part
> identity used by every downstream tool. Capture both from the search hit.

## Examples

### Partial MPN search with both symbol + footprint required

```json
{
  "query": "STM32F103",
  "requirements": { "symbol": true, "footprint": true },
  "page_size": 10
}
```

### Passive with package + value

```json
{
  "query": "0402 10k resistor",
  "requirements": { "symbol": true, "footprint": true }
}
```

### Functional description, English responses

```json
{
  "query": "32-bit microcontroller 72MHz LQFP64",
  "require_eda_model": true,
  "language": "en"
}
```

### Channel B — `client.parts.searchParts`

Same parameters in camelCase (`page_size` → `pageSize`,
`require_eda_model` → `requireEdaModel`):

```typescript
const page = await client.parts.searchParts({
  query: "STM32F103",
  requirements: { symbol: true, footprint: true },
  pageSize: 10,
});
for (const i of page.items) {
  console.log(i.mpn, i.manufacturer.id, i.package, i.hasSymbol, i.hasFootprint);
}
```

## Caching & Freshness

- Both channels (DSH tool / `client.parts`) hit the Huaqiu API directly with
  no cache; only the optional HQ Edge gateway caches results (~1 minute).
- Do not rely on the cache for time-sensitive availability — use
  `get_hqsch_supply_chain` for stock/price.

## Errors

| Error type | HTTP status | Meaning |
| --- | --- | --- |
| `InvalidRequest` | 400 | malformed body / failed zod validation |
| `UpstreamError` | 502 | Huaqiu host unreachable / 5xx |
| `UpstreamApiError` | 502 | Huaqiu returned a non-success `code` |
| `UpstreamValidation` | 502 | Huaqiu response failed schema validation |

See the main [SKILL.md](../part-search.md) for the progressive workflow.
