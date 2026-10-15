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
  [`placement-place-kicad-symbol`](rpc/placement-place-kicad-symbol.md)
  after `get_hqsch_part_models` returns symbol/footprint URLs (maps to
  `SCH_PlaceKicadSymbolFromResource`). Fall back to
  [`placement-place-part-from-library`](rpc/placement-place-part-from-library.md)
  only when online search has no suitable match.
- Editing object properties of an already-placed part — use
  [`canvas-set-object-property`](rpc/canvas-set-object-property.md).
- BOM extraction from an existing schematic — use
  `bom-get-bom`. Part search is for *discovery*;
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
  cheap.
- `get_hqsch_part` requires the *exact* `(manufacturerId, mpn)` pair that
  `search` returned — partial identifiers are rejected. It returns the full
  detail blob.
- `get_hqsch_part_models` returns *only* the EDA model URLs — call it when
  you already know the part and just need to know which models exist and
  where to fetch them.
- `get_hqsch_supply_chain` returns volatile stock/price data — call it last,
  only when procurement or availability gating is actually needed.

Both channels call the Huaqiu API directly with **no client-side cache**;
only the optional HQ Edge gateway caches (search / supply-chain ~1 min,
detail / models ~10 min). Don't re-issue identical calls in a loop.

Skipping `search` and jumping to `get_hqsch_part` with a guessed MPN almost
always fails: Huaqiu manufacturer IDs are opaque numeric strings (e.g.
`7189` = STMicroelectronics) that the agent cannot guess. Always discover
them through `search`.

## Two Access Channels

The same four operations are reachable two ways. Both are backed by
`@huaqiu/part-search`, talk directly to the public Huaqiu API
(`https://kiapi.eda.cn`, unauthenticated), and return the **same normalized
JSON** — only the calling convention differs.

| Channel | When | How |
| --- | --- | --- |
| **A · DSH tools** | The agent runtime exposes `search_hqsch_parts` & co. (DSH with `@huaqiu/dsh-tool-part-search` installed) | Call the tools from the conversation; snake_case parameters |
| **B · `client.parts` in a script** | No part-search tools available (Codex, Claude, Work Buddy, plain scripts) | `@huaqiu/huaqiu-client` → `client.parts.searchParts(...)` etc.; camelCase parameters |

**Pick A when the tools exist, otherwise B.** Do not mix them for the same
lookup. Neither channel needs HQ Edge: Edge's `/api/hqsch/parts/*` is an
optional gateway (caching + error envelope for HQSCH clients), not a
prerequisite.

`client.parts` is a plain HTTP client — it works before or without
`connect()` to HQ EDA. Only **placement** needs the editor connection.

### Channel A — DSH tools
| --- | --- | --- | --- |
| [`search_hqsch_parts`](part-search/search.md) | search | 1 — discover candidates | Keyword → paginated candidate list with model-availability flags |
| [`get_hqsch_part`](part-search/part-detail.md) | detail | 2 — inspect a candidate | Full part detail by `(manufacturerId, mpn)` |
| [`get_hqsch_part_models`](part-search/eda-models.md) | models | 3 — verify EDA coverage | Symbol / footprint / 3D / simulation URLs only |
| [`get_hqsch_supply_chain`](part-search/supply-chain.md) | supply-chain | 4 — procurement | Stock / MOQ / lead time / price breaks (batched) |

Full parameter tables, response shapes, and worked examples for each tool
are in the [references/](part-search/) subfolders.

### Channel B — `client.parts` (script)

| Tool (channel A) | `client.parts` method (channel B) | Parameter mapping |
| --- | --- | --- |
| `search_hqsch_parts` | `searchParts({ query, page, pageSize, requireEdaModel, requirements, language })` | `page_size` → `pageSize`, `require_eda_model` → `requireEdaModel` |
| `get_hqsch_part` | `getPart({ manufacturerId, mpn }, language?)` | `manufacturer_id` → `manufacturerId` |
| `get_hqsch_part_models` | `getEdaModels({ manufacturerId, mpn })` | same |
| `get_hqsch_supply_chain` | `getSupplyChain([{ manufacturerId, mpn }, ...])` | `parts[].manufacturer_id` → `manufacturerId` |

```typescript
import { connect } from "@huaqiu/huaqiu-client";

const client = await connect();
const page = await client.parts.searchParts({
  query: "STM32F103",
  requirements: { symbol: true, footprint: true },
  pageSize: 10,
});
const hit = page.items.find((i) => i.hasSymbol && i.hasFootprint);
if (!hit) throw new Error("no candidate with symbol + footprint");
const models = await client.parts.getEdaModels({
  manufacturerId: hit.manufacturer.id!,
  mpn: hit.mpn,
});
```

Return values are the TypeScript types exported by `@huaqiu/part-search`
(`PartSearchPage`, `Part`, `EdaModels`, `SupplyOffer`); channel A returns the
same objects as JSON with absent optional fields omitted.

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
[`placement-place-kicad-symbol`](rpc/placement-place-kicad-symbol.md)
(`PlaceKicadSymbol` → `SCH_PlaceKicadSymbolFromResource`) to drop the symbol on
the canvas. Part search's job ends at returning the model metadata; only fall
back to [`placement-place-part-from-library`](rpc/placement-place-part-from-library.md)
when online search finds no usable candidate.

## Handing Off to Placement

Placement always runs in a script against HQ EDA, whichever channel found the
part. Map `EdaModels` onto `client.componentPlace.placeKicadSymbol` like this:

| `EdaModels` / search hit | `placeKicadSymbol` field |
| --- | --- |
| `symbol.url` (required) | `component.symbolResource.uri` |
| `footprint.url` | `component.footprintResources[0].uri` |
| `model3d.url` | `component.footprintResources[0].models[0].uri` |
| `footprint.fileName` (fallback: hit `package`; may be an opaque hash) | attribute `Footprint` |
| `mpn` | attribute `MPN` |

With channel A, carry the chosen `(manufacturerId, mpn)` into the script and
re-fetch models there with one `getEdaModels` call instead of pasting URLs by
hand.

**Who picks the part — always the agent, after seeing candidates.** This
applies to every part, passives included:

1. Look at the candidates first — channel A: `search_hqsch_parts`; channel B:
   run the read-only `search-parts.ts` script (prints MPN, `manufacturerId`,
   package, model flags).
2. Choose one explicitly (`hasSymbol && hasFootprint`, matching package /
   value) and write the chosen `(manufacturerId, mpn)` into the placement
   script.
3. Never let a placement script pick "the first hit" of a query on its own.

## Underlying Implementation

| Layer | Responsibility |
| --- | --- |
| This skill (`skills/eda/part-search`) | Agent knowledge: when/how to search, workflow, query strategy |
| `@huaqiu/part-search` | The single implementation: Huaqiu HTTP client (direct to `kiapi.eda.cn`) + normalized domain models + zod schemas |
| `@huaqiu/dsh-tool-part-search` | Channel A: DSH adapter registering the four tools; calls `@huaqiu/part-search` directly |
| `@huaqiu/huaqiu-client` (`.parts`) | Channel B: exposes `PartSearchService` next to the HQ EDA gRPC clients |
| HQ Edge `/api/hqsch/parts/*` | Optional gateway for HQSCH clients (caching, validation, error envelope); not required by either channel |

Never guess `manufacturerId` or an exact MPN — every downstream call starts
from a search hit, in both channels.

## Related Skills

- [`placement-place-kicad-symbol`](rpc/placement-place-kicad-symbol.md) — **preferred:** place part from online EDA models (`SCH_PlaceKicadSymbolFromResource`).
- [`placement-place-part-from-library`](rpc/placement-place-part-from-library.md) — fallback: place from local/builtin part library.
- `bom-get-bom` — extract the BOM of parts already placed (not discovery).
- `erc-run-checks` — validate the design after parts are placed.

## References

- [Search reference](part-search/search.md) — `search_hqsch_parts` parameters, response, examples.
- [Part detail reference](part-search/part-detail.md) — `get_hqsch_part`.
- [EDA models reference](part-search/eda-models.md) — `get_hqsch_part_models`.
- [Supply chain reference](part-search/supply-chain.md) — `get_hqsch_supply_chain`.
