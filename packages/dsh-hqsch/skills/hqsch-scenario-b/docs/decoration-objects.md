# 装饰图元：模块框与自由文本（Rect / PlaceText）

`PlaceRect`、`PlaceText` 画的 **模块框、中文标题** 不是电气对象。**GetSnapshot** 与 **getPageOccupancy** 当前 **列不出** 它们（快照 `labels[]` 是 **NetAlias**，不是 `PlaceText`）。Agent 若靠快照/occupancy 找 id，会 **删不掉、改不了**。

采用 **A 为主、E 为补** 的策略（省 token、少拉全量快照）。

## A — 主路径：放置时登记 `objectId`（零额外 RPC）

每次 `placeRect` / `placeText` **成功返回后立刻**写入脚本内账本（或 `template/scripts/modular-lib.ts` 的 `recordDecoration`）：

| 字段 | 说明 |
| --- | --- |
| `kind` | `"rect"` \| `"text"` |
| `objectId` | RPC 响应 `objectId`（bigint） |
| `moduleKey` | 可选，模块名（如 `power`、`mcu`） |
| `label` | 可选，标题文字或备注 |

```typescript
import { recordDecoration, decorationObjectIds } from "./modular-lib";

const rectRes = await client.objPlace.placeRect({ /* box ext coords */ });
recordDecoration({ kind: "rect", objectId: BigInt(rectRes.objectId!), moduleKey: "mcu", label: "MCU" });

const textRes = await client.objPlace.placeText({ /* extX, extY, text */ });
recordDecoration({ kind: "text", objectId: BigInt(textRes.objectId!), moduleKey: "mcu", label: "MCU 最小系统" });

// 删除本模块装饰（勿用 GetSnapshot 找 id）
await client.canvasOps.deleteObjectsByIds({
  context: ctx,
  objectIds: decorationObjectIds({ moduleKey: "mcu" }),
});
// 等价封装（推荐，流程 C 单模块修补）：
await deleteModuleDecorations(client, ctx, "mcu");
```

**硬性约定**

- P4a 画框/标题：**禁止**跳过登记。
- P4c union：**必须**用账本里的 id + `getObjectJsonById` 并入 bbox（见 `modular-layout-hq-mapping.md`）。
- 重跑脚本前：**先删旧框/字**（账本 id 或 **`listPageDecorations` 删全页装饰**），再 place —— **禁止**为找框而 `GetSnapshot`。
- **清页重画**：occupancy 清器件 **不够**；必须 `deleteAllPageDecorations` / `clearActivePageFull`（见 `modular-layout.md`「清页/重跑」）。

**持久化（跨会话必做）**：账本只活在当前 node 进程里，下一个任务换进程就丢。脚本结束前 `saveDecorationLedger()`（默认写 `artifacts/decoration-ledger.json`，bigint → string，可用 `DECORATION_LEDGER` 环境变量指定路径），下次开头 `loadDecorationLedger()` 读回，才能继续按 `moduleKey` 精确删框/字。

## E — 补路径：`listPageDecorations`（已实现）

**不要**为找框/字去拉全工程 **GetSnapshot**（~1.6–3s + 大 payload，费 token）。

```typescript
import { listPageDecorations } from "./modular-lib";

const items = await listPageDecorations(client, ctx);
for (const it of items) {
  // kind: PAGE_DECORATION_KIND_RECT | PAGE_DECORATION_KIND_TEXT（或数字 1/2）
  // box.min/max：ext 坐标，Y 向下；text 仅 TEXT
  console.log(it.objectId, it.kind, it.text ?? "");
}
await client.canvasOps.deleteObjectsByIds({
  context: ctx,
  objectIds: items.filter((i) => String(i.text).includes("MCU")).map((i) => BigInt(i.objectId)),
});
```

`deleteAllPageDecorations` 已内置 **三级降级**：`listPageDecorations` RPC → 本地/落盘账本 → `selectAll` + `getSelectedObjectsJson` 按字段特征筛选（老客户端构建没有该 RPC 时的兜底，只认自由字与矩形，不会误删位号或 NetAlias）。

| 场景 | 用法 |
| --- | --- |
| 会话丢了账本、**用户手动画**了框/字 | **E** → `deleteObjectsByIds`；或直接 `deleteAllPageDecorations`（自带兜底） |
| 自己刚 place 且已 **A 登记** | 优先账本 id；可选 E 校验是否仍在页上 |
| Flow B 读电路语义 | 仍以 snapshot 器件/net 为主；框/字用 **E** 按需 |

Skill：`canvas-list-page-decorations`；`probe-rpc.ts` 含 `listPageDecorations` 探测。

## 禁止

| 禁止 | 原因 |
| --- | --- |
| 用 `GetSnapshot` / `labels[]` 找模块 `PlaceText` | `labels` 是 NetAlias；自由字不在快照 |
| 用 `getPageOccupancy` 枚举框/字 | 只含 part/symbol（+可选 wire） |
| 无 `objectId` 时 bulk `deleteObjectsByIds` 清页 | 见 `editing-a-circuit.md` |
| `PlaceTextFromVirtual` + 点击链 | 自动化禁止；且无稳定 id 登记 |

## 相关 RPC skill

- `obj-place-place-rect` / `obj-place-place-text` — 响应 **`objectId` 必填登记**
- `canvas-delete-objects-by-ids` — 删除时只传账本或 **E** 返回的 id
- `canvas-get-object-json-by-id` — P4c 算 union bbox
