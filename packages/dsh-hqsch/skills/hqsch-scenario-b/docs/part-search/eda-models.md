---
name: eda-part-search-models
metadata:
  category: part-search
  tool: get_hqsch_part_models
  operation: models
  description: >-
    Get EDA model metadata (schematic symbol / PCB footprint / 3D / simulation)
    URLs for a part by manufacturer id + MPN. Does not download the files.
---

# `get_hqsch_part_models` — EDA Models Reference

Returns **only** the EDA model metadata for a part: which model types exist
and where to fetch them. It does **not** download the model files. Use this
after `get_hqsch_part` (or directly after `search_hqsch_parts` if you only
care about model coverage) to hand the URLs to the placement / import
skills.

## When to call

- You need the symbol / footprint / 3D / simulation URLs for a part you've
  already identified.
- You want to confirm EDA-model coverage without paying for the full part
  detail blob.
- A placement or import skill needs the model URL to fetch and place.

Do **not** call this to discover parts — use `search_hqsch_parts` first.

## Parameters

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `manufacturer_id` | `string` | **yes** | Huaqiu manufacturer id, from `search_hqsch_parts`. |
| `mpn` | `string` | **yes** | Manufacturer Part Number. Exact match. |

> `language` is not accepted here — model URLs are language-independent.

## Response

An `EdaModels` object. Each key is **omitted** (not `null`) when the part has
no model of that kind:

| Field | Type | Description |
| --- | --- | --- |
| `symbol` | `EdaModel?` | schematic symbol |
| `footprint` | `EdaModel?` | PCB footprint |
| `model3d` | `EdaModel?` | 3D model |
| `simulation` | `EdaModel?` | simulation model |

### `EdaModel`

| Field | Type | Description |
| --- | --- | --- |
| `url` | `string` | absolute download URL for the model file |
| `fileName` | `string?` | file name Huaqiu stored — may be a readable name or an opaque hash; don't rely on it as a package name |
| `format` | `string?` | format hint (e.g. `kicad_sym`, `kicad_mod`) |
| `vendorId` | `number?` | Huaqiu vendor id (e.g. `32` = KiCad native) |

## Example

```json
{
  "manufacturer_id": "7189",
  "mpn": "STM32F103C8T6"
}
```

### Representative response

```json
{
  "symbol": { "url": "https://example.com/.../STM32F103C8T6.kicad_sym", "fileName": "STM32F103C8T6", "format": "kicad_sym", "vendorId": 32 },
  "footprint": { "url": "https://example.com/.../LQFP-48.kicad_mod", "fileName": "ccb32feceadc4298b406326a506ce8e7", "format": "kicad_mod", "vendorId": 32 },
  "model3d": { "url": "https://example.com/.../LQFP-48.step", "format": "step" }
}
```

### Channel B — `client.parts.getEdaModels`

```typescript
const models = await client.parts.getEdaModels({ manufacturerId: "7189", mpn: "STM32F103C8T6" });
if (!models.symbol?.url) throw new Error("no schematic symbol");
```

## What to do with the URLs

- **Symbol URL** (+ footprint / 3D URLs) → pass to
  [`placement-place-kicad-symbol`](../rpc/placement-place-kicad-symbol.md)
  (`PlaceKicadSymbol`); the engine downloads and converts the files. Field
  mapping is in [SKILL.md § Handing Off to Placement](../part-search.md#handing-off-to-placement).
- **No symbol** → pick another candidate from `search_hqsch_parts`; only fall
  back to [`placement-place-part-from-library`](../rpc/placement-place-part-from-library.md)
  when no online candidate has one.

Do not `fetch()` the model URLs yourself — `PlaceKicadSymbol` does the
download inside HQ EDA.

## Caching & Freshness

- Model URLs are stable (a model is published once per part revision). Both
  channels call the Huaqiu API directly with no cache; only the optional HQ
  Edge gateway caches model metadata (~10 minutes).
- If a model is reported `null`, the part genuinely has no model of that
  type — paging will not surface one. Try a different candidate from
  `search_hqsch_parts`.

## Errors

| Error type | HTTP status | Meaning |
| --- | --- | --- |
| `InvalidRequest` | 400 | missing `manufacturerId` / `mpn` |
| `PartNotFound` | 404 | no part at that `(manufacturerId, mpn)` |
| `PartModelNotFound` | 404 | part exists but has no EDA models at all |
| `UpstreamError` | 502 | Huaqiu host unreachable |

See the main [SKILL.md](../part-search.md) for the progressive workflow.
