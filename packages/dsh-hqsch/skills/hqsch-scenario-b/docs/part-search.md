---
name: eda-part-search
metadata:
  category: part-search
  scope: capability
description: >-
  Search and inspect electronic components and EDA models (symbol, footprint, 3D, simulation) plus supply-chain data. Invoke when the user needs to find an MPN, compare parts, or obtain model URLs before schematic placement — always call search before getEdaModels or PlaceKicadSymbol.
version: 0.1.0
vendor: Huaqiu Electronics
providers:
  - huaqiu
tags:
  - eda
  - huaqiu
  - part-search
  - components
  - mpn
  - symbol
  - footprint
entry: "@huaqiu/huaqiu-client"
manifest: "@huaqiu/huaqiu-client/skill.json"
---

# EDA Part Search

Hand-authored capability skill for **searching and inspecting electronic
components** and their EDA models. Use this when an agent needs to turn a
vague functional need ("I need a 32-bit MCU around 72 MHz") or a partial MPN
into concrete, EDA-ready part identities backed by a schematic symbol, PCB
footprint, 3D model, and supply-chain availability.

> **This is a capability skill, not a protobuf-generated skill.** The 121
> generated EDA capabilities (BOM, ERC, canvas, placement, …) live in
> sibling folders and are regenerated from the Connect-ES SDK surface. This
> skill is hand-authored because its value is *agent reasoning* — when to
> search, how to constrain a query, how to verify EDA-model coverage, and
> when to fall back — none of which is expressible in a protobuf contract.

## When to Use

Use this capability when the user, a playbook, or another skill needs to:

- **Find a component** by keyword, partial MPN, or functional description
  (e.g. "STM32F103", "0402 10k resistor", "32-bit microcontroller 72MHz").
- **Compare candidate MPNs** for the same functional role and pick one.
- **Inspect a part's specifications** — attributes, categories, datasheets,
  package, tags — before committing to it in a design.
- **Retrieve EDA models** — confirm a schematic symbol / PCB footprint / 3D
  model / simulation model exists and obtain the URL to fetch it.
- **Inspect supply-chain information** — stock, MOQ, lead time, price breaks,
  distributor links — for procurement or availability gating.

Do **not** use this skill for:

- Placing a part you already fully identified onto the canvas — use
  [`placement-place-kicad-symbol`](../placement/place-kicad-symbol/SKILL.md)
  after `get_hqsch_part_models` returns symbol/footprint URLs (maps to
  `SCH_PlaceKicadSymbolFromResource`). Fall back to
  [`placement-place-part-from-library`](../placement/place-part-from-library/SKILL.md)
  only when online search has no suitable match.
- Editing object properties of an already-placed part — use
  [`canvas-set-object-property`](../canvas/set-object-property/SKILL.md).
- BOM extraction from an existing schematic — use
  [`bom-get-bom`](../bom/get-bom/SKILL.md). Part search is for *discovery*;
  BOM is for *what is already placed*.

## The Semantic Workflow

Part search is a **progressive retrieval** capability. Never call
`get_hqsch_part` or `get_hqsch_part_models` with a keyword you invented —
always start from `search_hqsch_parts` and drill down using the
`manufacturerId` + `mpn` pair the search returns.

```
  user need (keyword / partial MPN / description)
         │
         ▼
  1. search_hqsch_parts          → candidate list (MPN, mfr, package, model flags)
         │  pick a candidate
         ▼
  2. get_hqsch_part              → full detail (attributes, datasheets, tags)
         │  confirm it fits
         ▼
  3. get_hqsch_part_models       → EDA model metadata (symbol/footprint/3D URLs)
         │  optional, for procurement
         ▼
  4. get_hqsch_supply_chain      → stock / MOQ / lead time / price breaks
```

**Why this order matters:**

- `search` is fuzzy and paginated; it returns *just enough* to choose a
  candidate (MPN, manufacturer, package, model-availability flags). It is
  cheap and cached for ~1 minute.
- `get_hqsch_part` requires the *exact* `(manufacturerId, mpn)` pair that
  `search` returned — partial identifiers are rejected. It returns the full
  detail blob and is cached for ~10 minutes.
- `get_hqsch_part_models` returns *only* the EDA model URLs — call it when
  you already know the part and just need to know which models exist and
  where to fetch them. Cached ~10 minutes.
- `get_hqsch_supply_chain` returns volatile stock/price data — call it last,
  only when procurement or availability gating is actually needed. Cached
  ~1 minute.

Skipping `search` and jumping to `get_hqsch_part` with a guessed MPN almost
always fails: Huaqiu manufacturer IDs are opaque numeric strings (e.g.
`7189` = STMicroelectronics) that the agent cannot guess. Always discover
them through `search`.

## Available Tools

This skill is exposed to agents as four DSH tools registered by the
`@huaqiu/dsh-tool-part-search` plugin. Each tool calls HQ Edge's internal
`/api/hqsch/parts/*` API — **agents never contact the upstream Huaqiu host
directly.** The underlying implementation lives in
[`@huaqiu/huaqiu-client`](https://www.npmjs.com/package/@huaqiu/huaqiu-client)
under the `parts` namespace (built on the reusable `@huaqiu/part-search`
package), and HQ Edge is the single owner of the Huaqiu integration.

| Tool | Operation | Progressive step | Detail |
| --- | --- | --- | --- |
| [`search_hqsch_parts`](references/search.md) | search | 1 — discover candidates | Keyword → paginated candidate list with model-availability flags |
| [`get_hqsch_part`](references/part-detail.md) | detail | 2 — inspect a candidate | Full part detail by `(manufacturerId, mpn)` |
| [`get_hqsch_part_models`](references/eda-models.md) | models | 3 — verify EDA coverage | Symbol / footprint / 3D / simulation URLs only |
| [`get_hqsch_supply_chain`](references/supply-chain.md) | supply-chain | 4 — procurement | Stock / MOQ / lead time / price breaks (batched) |

Full parameter tables, response shapes, and worked examples for each tool
are in the [references/](references/) subfolders.

## Query Strategy

### Prefer exact MPN, then constrain, then go fuzzy

1. **Exact / partial MPN** — if the user gives an MPN or partial MPN
   (`STM32F103`, `LMV761`), search with that string directly. Matching is
   fuzzy, so related grades/packages will also surface.
2. **Constrained specification search** — if no MPN is known, describe the
   part functionally (`32-bit microcontroller 72MHz LQFP64`) and combine
   with the `requirements` filter to insist on the EDA models you need:
   ```json
   {
     "query": "32-bit microcontroller 72MHz",
     "requirements": { "symbol": true, "footprint": true }
   }
   ```
3. **Package + value** for passives — `0402 10k resistor`, `0805 100nF cap`.
   The search index understands common package codes.

### Always insist on the EDA models you actually need

By default `search_hqsch_parts` returns only parts that have *some* EDA
model (`require_eda_model` defaults to `true`). For a real PCB design you
usually need **both** a symbol and a footprint — set `requirements`:

```json
{ "query": "STM32F103", "requirements": { "symbol": true, "footprint": true } }
```

Set `require_eda_model: false` only for research / market-survey tasks where
you explicitly want parts without EDA models (e.g. checking whether a
competitor's part is catalogued at all).

### Don't over-page

`search_hqsch_parts` returns up to 50 items per page. If the first page
doesn't contain a usable candidate, **refine the query** before paging
forward — adding package code, manufacturer, or a `requirements` filter is
almost always more effective than scanning page 2+.

## Response Language

All four tools accept a `language` field (`"zh"` default, `"en"` available).
Use `"en"` when the agent's working language or the downstream report is
English; `"zh"` for HQSCH-native workflows. Descriptions, category names,
and tag labels are translated; technical fields (MPN, manufacturer id,
URLs) are not.

## Worked Example: "Find an STM32F103 for a USB HID gadget"

```
Step 1 — search with EDA-model requirements
  search_hqsch_parts({
    "query": "STM32F103",
    "requirements": { "symbol": true, "footprint": true, "model3d": true },
    "page_size": 10
  })
  → returns candidates incl. STM32F103C8T6 (mfr 7189, LQFP48, all models ✓)

Step 2 — inspect the chosen candidate
  get_hqsch_part({
    "manufacturer_id": "7189",
    "mpn": "STM32F103C8T6"
  })
  → confirms core/clk/flash/USB attributes, links the datasheet

Step 3 — fetch model URLs (for the placement step later)
  get_hqsch_part_models({
    "manufacturer_id": "7189",
    "mpn": "STM32F103C8T6"
  })
  → returns symbol URL, footprint URL, 3D URL

Step 4 — (optional, procurement) check availability
  get_hqsch_supply_chain({
    "parts": [{ "manufacturer_id": "7189", "mpn": "STM32F103C8T6" }]
  })
  → stock / MOQ / price breaks
```

Once step 3 returns model URLs, hand off to
[`placement-place-kicad-symbol`](../placement/place-kicad-symbol/SKILL.md)
(`PlaceKicadSymbol` → `SCH_PlaceKicadSymbolFromResource`) to drop the symbol on
the canvas. Part search's job ends at returning the model metadata; only fall
back to [`placement-place-part-from-library`](../placement/place-part-from-library/SKILL.md)
when online search finds no usable candidate.

## Underlying Implementation

| Layer | Owner | Responsibility |
| --- | --- | --- |
| This skill (`skills/eda/part-search`) | AI Systems Team | Agent knowledge: when/how to search, workflow, query strategy |
| `@huaqiu/huaqiu-client` (`.parts` namespace) | Huaqiu AI Platform | Thin executable client boundary for HQ EDA / HQSCH |
| `@huaqiu/part-search` (this skill's runtime impl) | Huaqiu AI Platform | Raw Huaqiu HTTP client + normalized domain models + zod schemas |
| HQ Edge `/api/hqsch/parts/*` | HQ Edge Server | HTTP API with caching, validation, error envelope — consumed by HQSCH and the DSH plugin |
| `@huaqiu/dsh-tool-part-search` | HQ Edge Server | DSH adapter: registers the four agent tools, calls HQ Edge only |

Agents and skills must address part search **only** through the four tools
above. They must not attempt to call `@huaqiu/huaqiu-client` directly from
skill text, and the DSH plugin must not contact the upstream Huaqiu host —
HQ Edge is the single integration owner.

## Related Skills

- [`placement-place-kicad-symbol`](../placement/place-kicad-symbol/SKILL.md) — **preferred:** place part from online EDA models (`SCH_PlaceKicadSymbolFromResource`).
- [`placement-place-part-from-library`](../placement/place-part-from-library/SKILL.md) — fallback: place from local/builtin part library.
- [`bom-get-bom`](../bom/get-bom/SKILL.md) — extract the BOM of parts already placed (not discovery).
- [`erc-run-checks`](../erc/run-checks/SKILL.md) — validate the design after parts are placed.

## References

- [Search reference](references/search.md) — `search_hqsch_parts` parameters, response, examples.
- [Part detail reference](references/part-detail.md) — `get_hqsch_part`.
- [EDA models reference](references/eda-models.md) — `get_hqsch_part_models`.
- [Supply chain reference](references/supply-chain.md) — `get_hqsch_supply_chain`.
