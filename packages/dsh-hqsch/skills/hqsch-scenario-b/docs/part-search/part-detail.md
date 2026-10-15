---
name: eda-part-search-detail
metadata:
  category: part-search
  tool: get_hqsch_part
  operation: detail
  description: >-
    Get the canonical detailed part by manufacturer id + MPN. Returns
    attributes, categories, documents (datasheets), images, EDA-model
    metadata, and tags.
---

# `get_hqsch_part` — Part Detail Reference

Returns the full canonical part detail for a specific `(manufacturerId, mpn)`
pair. Call this **after** `search_hqsch_parts` has identified a candidate,
to inspect specifications, datasheets, and tags before committing the part
to a design.

## When to call

- You have a `(manufacturerId, mpn)` pair from `search_hqsch_parts`.
- A playbook asks for full attributes / datasheet links / tags.
- You need to verify a part fits electrical / package requirements before
  fetching its EDA models.

Do **not** call this to discover parts — use `search_hqsch_parts` first.
Partial or guessed identifiers are rejected: Huaqiu manufacturer IDs are
opaque numeric strings you cannot invent.

## Parameters

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `manufacturer_id` | `string` | **yes** | Huaqiu manufacturer id (e.g. `7189` = STMicroelectronics). Obtain from `search_hqsch_parts`. |
| `mpn` | `string` | **yes** | Manufacturer Part Number (e.g. `STM32F410T8Y6TR`). Exact match — no wildcards. |
| `language` | `"en"` \| `"zh"` | no | Response language. Default `"zh"`. |

## Response

A `Part` object (normalized domain model — raw Huaqiu field names do not
leak):

Optional fields are omitted when Huaqiu has no value.

| Field | Type | Description |
| --- | --- | --- |
| `mpn` | `string` | Manufacturer Part Number |
| `manufacturer` | `{ id?, name }` | manufacturer identity + display name |
| `huaqiuPn` | `string?` | Huaqiu internal part number |
| `package` | `string?` | package code (e.g. `LQFP48`) |
| `description` | `string?` | localized short description |
| `lifecycle` | `string?` | lifecycle status |
| `attributes` | `PartAttribute[]` | flattened attribute list |
| `categories` | `PartCategory[]` | `{ id?, name, displayName?, parentId?, level? }` taxonomy path |
| `documents` | `PartDocument[]` | `{ type, url, fileName?, vendor? }` datasheets / manuals |
| `images` | `PartImage[]` | `{ url, vendor? }` product images |
| `models` | `EdaModels` | same shape as `get_hqsch_part_models` (see [eda-models.md](eda-models.md)) |
| `tags` | `PartTag[]` | `{ label, type? }` catalog tags (e.g. `128KB Flash`) |

### `PartAttribute`

| Field | Type | Description |
| --- | --- | --- |
| `shortName` | `string?` | stable short key when provided (e.g. `supply_voltage`) |
| `name` | `string` | human-readable attribute name |
| `value` | `string` | attribute value, unit included in the string |
| `group` | `string?` | Huaqiu group (`Function`, `Physical`, `Compliance`, …) |

## Example

```json
{
  "manufacturer_id": "7189",
  "mpn": "STM32F103C8T6",
  "language": "en"
}
```

### Channel B — `client.parts.getPart`

```typescript
const part = await client.parts.getPart({ manufacturerId: "7189", mpn: "STM32F103C8T6" }, "en");
```

## Caching & Freshness

- Part specs are stable; only stock/price mutate.
- Both channels (DSH tool / `client.parts`) hit the Huaqiu API directly with
  no cache; only the optional HQ Edge gateway caches detail (~10 minutes).

## Errors

| Error type | HTTP status | Meaning |
| --- | --- | --- |
| `InvalidRequest` | 400 | missing `manufacturerId` / `mpn` |
| `PartNotFound` | 404 | no part at that `(manufacturerId, mpn)` |
| `UpstreamError` | 502 | Huaqiu host unreachable |
| `UpstreamApiError` | 502 | Huaqiu returned a non-success `code` |

If you see `PartNotFound`, the candidate from `search_hqsch_parts` is stale
or the identifiers were transposed — re-run the search and copy
`manufacturer.id` + `mpn` verbatim.

See the main [SKILL.md](../part-search.md) for the progressive workflow.
