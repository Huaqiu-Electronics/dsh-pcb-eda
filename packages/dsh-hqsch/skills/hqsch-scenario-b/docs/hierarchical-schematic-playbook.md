# Hierarchical schematic playbook (block ↔ child sheet)

Agent workflow for **true** hierarchical designs (parent block + child schematic folder).  
**Not** the same as [modular-layout-playbook.md](./modular-layout-playbook.md) (single-page modular frames).

Engine reference: `VxPstxnetNew::ReadFromDesign` → `ReadSchematicNet` / `ReadPageNet` → **`ConnectBlockPinAndPort`** → `MergeDesignNet`.

---

## 1. Terms

| Term | Meaning |
| --- | --- |
| **Block** | Parent-sheet hierarchical block; child via `ContentsViewName` + `Reference` |
| **Block pin** | Pin on block border; parent-sheet wires connect here |
| **Hierarchical port** | Child-sheet symbol **`LIBRARY_SYMBOL_KIND_PORT`** (not off-page, not part pin) |
| **occPath** | Design tree path, e.g. `/`, `/U_PWR` |
| **blockReference** | Block Reference; last segment of child `occPath` |

---

## 2. When to use what

| Mechanism | Use when |
| --- | --- |
| **Block + block pin + child port** | Submodule is a **separate schematic folder** |
| **Off-page** | Same folder, different **pages** — **`BY_NAME`** |
| **Global / power** | Design-wide name — **`BY_GLOBAL`** |
| **Modular grid on one page** | [modular-layout.md](./modular-layout.md) — **no** block hierarchy |
| **Default (user silent on hierarchy)** | Same as **modular grid on one page** — do **not** assume H0–H4 |

---

## 3. 层次布局（与单页模块化并列，互不混用）

**默认走单页**：用户没有明确说 **层次 / 分层 / 子原理图 / block 子页 / 多 schematic** 时，**不要**用本节，按 [modular-layout.md](./modular-layout.md) **P0–P4** 画一张页上的模块框即可。

用户**明确**要 **层次 / 分层 / 子原理图 / block 表示模块** 时走本节 **H0–H4**。  
用户只说模块框、仍要 **一张页上多个框** 时走 [modular-layout.md](./modular-layout.md) **P0–P4**，**不要**改成层次。

| 层 | 画什么 | 复用单页的哪一段 |
| --- | --- | --- |
| **顶层（父页）** | 每个功能模块一个 **block**（不是 placeRect 模块框） | 网格用 `planCompactZones` + `withMinA4` 排 **block 的 box**；**跨 block 只用短 stub + 同名 NetAlias**（`aliasBlockPins`），禁止长导线穿 block |
| **子页（每个 block 一张 schematic）** | 该模块的器件 + 层次 **port** | 当成 **单个模块**：P1 放置 → P2 电源名 → P3 pattern/模块内 PlaceWire → 可选 P3.5 收拢；**不要**在子页再画多模块网格框 |
| **页尺寸** | 顶层与每个子页 | **最小 A4 横向**（`A4_LANDSCAPE_EXT` 2970×2100 / `setPageExtAtLeastA4`）；内容更大再 Custom 放大。单页模块化任务 **不要**套这条下限 |
| **文字说明** | 顶层与子页 | 一行 `note`：功能、关键取值、对外 port 名；`placeText` + `recordDecoration` |

### H0 规划表（生成脚本前）

每个模块一行：`key` / 中文 `title` / `note` / `blockReference` / `contentsViewName` / `col`+`order` / **对外信号**（`pinName` = 子页 port **Name**）/ 器件 refs。  
≤3 件的小电路仍 `attachTo` 并入功能模块（与单页相同），**不要**为复位/BOOT 单独建 block。

### H1 顶层：只放 block，用标签连 pin

```text
plan = planCompactZones(顶层模块清单, withMinA4())
setPageExtAtLeastA4(client, ctx, plan.pageW, plan.pageH)
对每个模块：
  placeHierarchicalBlock({ box: plan.cells[key], contentsViewName, blockReference })
  每个对外信号 placeBlockPin(blockId, pinName)
  placeText 标题 + note（block 框内或紧贴上沿，recordDecoration）
跨 block 的同一网络：aliasBlockPins(pinA, pinB, netName)   // stub ≤ 40 ext
禁止 PlaceWire 从一块 block 拉到另一块
```

`blockReference` = 子 occ 最后一段；`pinName` 与子页 port Name **同一字符串**（§4）。

### H2 建子 schematic 并打开

`ensureChildSheet({ schematicName: contentsViewName, blockReference, projectName })`  
→ `AddSchematicToActiveProject`（已存在则忽略）→ `AddPageToProject` → `ActivatePageInProject`（`occPath` = `"/" + blockReference`）。  
打开后 **重新** `createProjectContext` + `calibratePageTop`。

### H3 子页：单模块布局 + port 贴电路

把该模块当成单页里的 **一个 zone**：

1. `plan = planCompactZones([{ key, title, note, refs, w, h, col: 0 }], withMinA4())` → `setPageExtAtLeastA4`
2. 器件放在 `atZone(plan.zones[key], …)`，规则同 `modular-layout.md` P1–P3（选型 → `placePartByMpn`、pattern、模块内 `connectPinsPlaceWire`）
3. **port**：对每个对外信号 `placePortNearPin({ portName, nearObjectId, nearPin, side })`  
   - `portName` = 顶层 `pinName`  
   - 放在所连引脚 **同侧、约 `PORT_NEAR_GAP`(80 ext)**，再用 PlaceWire 接到该脚  
   - **禁止** port 甩在页边、离电路一大截空白  
   - 电源/地：子页仍用 GLOBAL 符号贴引脚；只有 **要穿到别的 block** 的电源才既放符号又出 port
4. 简要文字：框内或页边一行 `title` + `note`（`placeModuleFrameAndTitle` 只画 **这一模块** 一框，或只 `placeText`）
5. `checkpointNets` → `persistProject`

### H4 回到顶层验收

`ActivatePageInProject` 回父页 → `getPortPairing` 看 **`BY_HIERARCHY`** → 顶层 `checkpointNets` → save。  
不要用显示名猜跨层网络。

### RPC 顺序

1. **Parent page (active)**  
   - [`PlaceBlock`](./rpc/placement-place-block.md): `contentsViewName`, `blockReference`, `box`  
   - [`PlaceBlockPin`](./rpc/placement-place-block-pin.md): `pinName` (see §4)  
   - **跨 block**：`aliasBlockPins` / `placeShortStubAlias`（H1；不要长导线）

2. **Ensure child schematic folder exists**  
   - `ListProjectTree` / `GetActiveProject` — if `contentsViewName` is missing:  
     [`project-add-schematic-to-active-project`](./rpc/project-add-schematic-to-active-project.md) (`schematicName` = `contentsViewName`; **no** default `PAGE1`)  
   - Then [`project-add-page-to-project`](./rpc/project-add-page-to-project.md) on that schematic (empty `pageName` → `PAGE1`).

3. **Open child sheet**  
   - `project.activatePageInProject`: `schematicName` = `contentsViewName`, `occPath` = parent occ + `"/" + blockReference`

4. **Child page**  
   - `ListSymbolLibraries` → [`PlaceSymbolFromLibrary`](./rpc/placement-place-symbol-from-library.md) with **`kind = PORT`**  
   - Port **Name** matches signal (§4); **`placePortNearPin`** — wire to the nearby part pin, not a distant page edge

5. **Block object id (for PlaceBlockPin)**  
   - After `placeBlock`: save **`objectId`**.  
   - Existing blocks: [`canvasOps.listPageBlocks`](./rpc/canvas-list-page-blocks.md) → `blocks[].objectId` (or `findObjectByProperty` on Reference).

6. **Persist & verify**  
   - `project-save-project`  
   - [`netList.getPortPairing`](./rpc/netlist-get-port-pairing.md) — **`BY_HIERARCHY`**  
   - Do **not** guess cross-layer nets by display name alone

---

## 4. Block pin ↔ child port merge (engine)

Parent net **`m_setBlockPin`** keys (after `ReadPageNet`):

```text
blockPinKey = strOccPrefix + blockReference + "_" + UPPER(pinName)
```

**`ConnectBlockPinAndPort`** matches when:

```text
blockPinName == childOccPathWithoutLeadingSlash + "_" + portName
```

**Agent convention:** same string for `PlaceBlockPin.pinName` and child port **Name**; `blockReference` = child occ segment.

---

## 5. Three pairing rules

| Rule | Meaning |
| --- | --- |
| `BY_NAME` | Off-page / same-folder port name |
| `BY_HIERARCHY` | Block pin ↔ child hierarchical port |
| `BY_GLOBAL` | Power / global names |

Read flow: **GetSnapshot** → **GetPortPairing** → **GetProjectNetList** ([reading-a-circuit.md](./reading-a-circuit.md)).

---

## 7. RPC index

| Step | RPC |
| --- | --- |
| Block | `componentPlace.placeBlock` |
| List blocks / pins | `canvasOps.listPageBlocks` |
| Block pin | `componentPlace.placeBlockPin` / `placeBlockPin` |
| Cross-block net | `aliasBlockPins` / `placeShortStubAlias` |
| Child port near pin | `placePortNearPin` |
| Min A4 page | `withMinA4` / `setPageExtAtLeastA4` |
| Child port | `componentPlace.placeSymbolFromLibrary` (PORT) |
| Navigate | `project.activatePageInProject` |
| Verify | `netList.getPortPairing` |
| Save | `project.saveProject` |
