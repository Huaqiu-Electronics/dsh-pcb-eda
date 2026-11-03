# PCBLint API 使用文档

覆盖从 **上传 .kicad_pcb** → **自定义 KiCad 内置校验开关** → **执行校验** → **获取校验结果** 的完整调用链。

- Base URL（本地单机部署默认）：`http://localhost:8080`
- Base URL（前端代理）：`http://localhost:1421/api/s`（Vite dev server 代理到后端）
- 所有会话相关接口需要 `X-Session-Token` 头部（上传后由后端返回，每次请求带上）
- 失败统一返回 `400 Bad Request`，body 形如 `{"error": "失败原因"}`

---

## 0. 会话标识

- 上传成功后返回 `sessionToken`（UUID 字符串）
- 后续所有需要"当前板子上下文"的接口，通过以下任一种方式传会话：
  - 请求头 `X-Session-Token: <token>` （推荐）
  - Query 参数 `?session=<token>` （两种同时出现时头部优先）

---

## 1. 上传 PCB 并解析

### `POST /api/s/upload`

上传一个 `.kicad_pcb` 文件，后端完成：
1. 用户内 MD5 查重（命中则复用，`reused=true`）
2. 软删记录复活（命中且物理文件还在则恢复原会话）
3. 新建会话、解析 Board、执行语义分类、打包预览 zip
4. 自动生成一份默认的 `.kicad_pro` 和 `.kicad_dru` 到 PCB 同目录

**注意**：不接受客户端指定会话 id，每次上传都新建一个会话（MD5 命中时返回已存在的会话）。

### 请求

```
Content-Type: multipart/form-data
Form field name: file
```

```bash
curl -X POST http://localhost:8080/api/s/upload \
  -F "file=@part_placed.kicad_pcb"
```

### 响应 200

```jsonc
{
  "sessionToken": "a1b2c3d4-...",
  "fileName": "part_placed.kicad_pcb",
  "board": {
    "units": "mm",
    "outline": [ { ... } ],          // 板框线段
    "layers":   [ { ... } ],          // stackup
    "components": [ {                 // 元件列表
      "reference": "U1",
      "value": "ESP32-S3",
      "footprint": "...",
      "position": { "x": 12.5, "y": 8.0 },
      "rotation": 0.0,
      "layer": "F.Cu"
    } ],
    "tracks":  [ { "from": {...}, "to": {...}, "layer": "F.Cu" } ],
    "vias":    [ { "at": {...}, "drill": 0.4 } ],
    "zones":   [ ... ],
    "drawings":[ ... ],
    "nets":    [ { "name": "VCC_3V3", "nodes": [...] } ]
  },
  "classification": {
    "componentCount": 42,
    "netCount": 8,
    "components": [ { "reference": "U1", "primaryRole": "mcu", "confidence": 0.96 } ],
    "nets":       [ { "netName": "VCC_3V3", "primaryRole": "power", "confidence": 0.88 } ]
  },
  "zipUrl": "http://localhost:8080/preview/.../part_placed.zip",
  "reused": false
}
```

| 字段 | 说明 |
|---|---|
| `sessionToken` | **后续所有接口必带** |
| `reused=true` | MD5 命中或软删复活，说明这块板之前在你的历史记录里存在过 |
| `board` | 完整解析结果（`copperLayers`、`boardThickness` 等标注了 `@JsonIgnore` 的字段不在 JSON 里） |
| `classification` | 语义分类结果，供规则引擎做 Role 匹配 |
| `zipUrl` | 上传时同步打包的 PCB 预览 zip（扁平结构），可直接给 `viewer.eda.cn/?zip-url=` 用 |

### 错误 400

```json
{"error": "File must be a .kicad_pcb file"}
```

---

## 2. 获取 / 修改校验开关（KiCad 内置 DRC 规则）

> 这个步骤是 pcblint 这次的新能力：让用户**只校验自己关心的 KiCad 内置规则**。
> 不启用的规则不会出现在最终结果里。
> 自定义的 `.kicad_dru` 规则（pcblint 自己跑的）不受此开关影响。

### 2.1 读取当前板子的全部开关

### `GET /api/s/drc-rules`

**请求**

```bash
curl http://localhost:8080/api/s/drc-rules \
  -H "X-Session-Token: a1b2c3d4-..."
```

### 响应 200

```jsonc
{
  "proFileName": "part_placed.kicad_pro",
  "proExists": true,
  "overrides": true,                          // 有用户显式保存过
  "rules": [
    {
      "key": "clearance",                     // KiCad .kicad_pro rule_severities 的 key
      "severity": "error",                    // error / warning / ignore
      "enabled": true,
      "locked": true                          // ⚠️ 自研 DRU 规则依赖该约束类型，不可关闭
    },
    { "key": "lib_footprint_issues", "severity": "error",   "enabled": true,  "locked": false },
    { "key": "malformed_courtyard",  "severity": "ignore",  "enabled": false, "locked": false },
    // ... 全部 58 条内置规则
  ]
}
```

**锁定规则说明**：DRU 里如果有 `(constraint clearance ...)`，那 `clearance` 这条 KiCad 内置规则就会被锁定并强制 `error`——因为自定义 DRU 规则**继承**其约束类型在 `.kicad_pro` 里的严重级别，强行设 `ignore` 会把 pcblint 自己的规则静默掉。锁定项在保存时会被忽略。

**持久化位置**：
- `<pcb同目录>/<basename>.kicad_pro` —— `rule_severities` 字段，被 kicad-cli 真实读取
- `<pcb同目录>/<basename>.pcblint-drc.json` —— sidecar，记录哪些是用户显式打开的（历史记录恢复后读这个）

### 2.2 保存开关

### `PUT /api/s/drc-rules`

**请求**

```bash
curl -X PUT http://localhost:8080/api/s/drc-rules \
  -H "X-Session-Token: a1b2c3d4-..." \
  -H "Content-Type: application/json" \
  -d '{
    "rules": {
      "lib_footprint_issues": "error",
      "silk_edge_clearance":  "warning",
      "malformed_courtyard":  "ignore",
      "unconnected_items":    "ignore"
    }
  }'
```

`rules` 是一个 `Map<String, String>`，value 只能是 `error` / `warning` / `ignore`。没出现的 key **保持原值不变**，锁定 key 会被忽略。

### 响应 200

和 GET 响应结构相同，是保存后的最新状态。

---

## 3. 执行校验

### `POST /api/s/lint-drc`

这是 pcblint 的主校验入口：

1. 把当前用户启用的规则编译成 `.kicad_dru` 并物理落盘
2. 根据校验开关面板的设置（上一步保存的），生成随 kicad-cli 一起提交的 `.kicad_pro`
3. 调用 kicad-cli 执行 DRC
4. 合并 KiCad 内置违规 + pcblint 规则违规 + 抑制项过滤 + 按 ruleId 分组

**请求**

```bash
curl -X POST http://localhost:8080/api/s/lint-drc \
  -H "X-Session-Token: a1b2c3d4-..."
```

无请求体。

### 响应 200

```jsonc
{
  "violations": [
    {
      "ruleId":    "crystal_keepout",          // pcblint 自研规则；KiCad 内置规则此字段可能为空
      "title":     "晶振禁留区内走线",
      "severity":  "ERROR",                   // ERROR / WARNING / INFO
      "confidence": "HIGH",
      "message":   "晶振 U1 Y1 周围 3mm 内发现 F.Cu 走线",
      "location":  { "x": 22.3, "y": 15.7 },
      "objects":   ["U1", "Y1", "F.Cu: net=I2C_SDA"],
      "suggestion": null,
      "backend":   "EDA_DRC"                  // EDA_DRC / NATIVE / MANUAL
    },
    {
      "ruleId":    null,                      // KiCad 内置规则没有 pcblint 的 ruleId
      "title":     "丝印边缘间隙不足",
      "severity":  "ERROR",
      "message":   "silk_edge_clearance: 丝印距离板框太近",
      "location":  { "x": 31.8, "y": 2.1 },
      "objects":   ["F.SilkS"],
      "backend":   "EDA_DRC"
    }
  ],
  "groups": [
    {
      "key":      "crystal_keepout",           // pcblint 规则 → ruleId
      "count":    2,
      "severity": "ERROR",
      "backend":  "EDA_DRC",
      "sample": { "title": "...", "message": "...", "location": {...}, "objects": [...] }
    },
    {
      "key":      "silk_edge_clearance",       // KiCad 内置 → message 首段冒号前
      "count":    4,
      "severity": "ERROR",
      "backend":  "EDA_DRC",
      "sample": { "title": "...", "message": "...", "location": {...}, "objects": [...] }
    }
  ],
  "suppressedCount": 0,
  "rulesExecuted":   12,
  "nativeRulesCount": 4,
  "drcRulesCount":    8,
  "manualRulesCount": 0,
  "kicadDrcAvailable": true,
  "kicadDrcUsed":      true
}
```

| 字段 | 说明 |
|---|---|
| `violations[]` | 完整违规列表，按出现顺序排列 |
| `groups[]` | 前端 tab 里的分组统计摘要（按 ruleId 或 message 首段） |
| `groups[].sample` | 该组第一条违规的精简信息，用于 tooltip / 采样展示 |
| `suppressedCount` | 被抑制（已在抑制列表）的违规数量 |
| `kicadDrcAvailable=false` | kicad-cli 不可用，所有 EDA_DRC 规则被自动 fallback 到 NATIVE |
| `kicadDrcUsed=true` | 实际调用了 kicad-cli（有 DRC 规则 + kicad 可用时成立） |

### 分组规则（groups.key 怎么来的）

| 场景 | groups.key |
|---|---|
| pcblint 规则（ruleId 非空） | ruleId 本身，如 `crystal_keepout` |
| KiCad 内置（ruleId 为空，message 形如 `"clearance: ..."`） | message 第一个冒号前的子串，如 `clearance` |
| 都没有 | `"other"` |

### 校验开关如何影响结果

- **没开任何内置规则**（首次使用的默认状态）→ 结果里只有 pcblint 自研规则的违规
- **打开了 `lib_footprint_issues`** → 该规则的 KiCad 违规会出现在 `violations` 和 `groups` 里，`groups[].key = "lib_footprint_issues"`
- **DRU 依赖的约束类型**（如 `clearance`）即使开关面板里用户没开，也不会完全消失——因为 `.kicad_pro` 里该约束类型被强制设为 `error`，同时 lint-drc 在解析阶段只放行「DRU 自研规则 + 面板里显式打开的内置规则」，约束类型相关的内置违规仍会被丢弃

---

## 4. 后续查询（可选）

### 4.1 只跑 Native 规则（不走 kicad-cli）

### `POST /api/s/lint`

和 `/lint-drc` 结构一样，但不走 KiCad DRC 路径。返回：

```json
{
  "violations": [...],
  "suppressedCount": 0,
  "rulesExecuted": 12
}
```

### 4.2 读取已生成的 DRU 内容

### `GET /api/s/dru`

```bash
curl http://localhost:8080/api/s/dru -H "X-Session-Token: ..."
```

响应：
```json
{
  "fileName": "part_placed.kicad_dru",
  "content": "(version 1)\n(rule \"crystal_keepout\" ...)\n",
  "modified": false           // 用户是否在 DRU 面板里改过
}
```

### 4.3 下载 DRU 文件（浏览器直链）

### `GET /api/s/download-dru?session=<token>`

返回 `text/plain` 流，`Content-Disposition: attachment`。

### 4.4 历史记录 & 恢复

### `GET /api/s/sessions?page=0&size=10`

```json
{
  "content": [
    {
      "id": "a1b2c3d4-...",
      "fileName": "part_placed.kicad_pcb",
      "zipUrl": "http://localhost:8080/preview/...",
      "componentCount": 42,
      "lastAccessAt": "2026-11-02T14:32:10"
    }
  ],
  "totalElements": 5,
  "totalPages": 1,
  "number": 0,
  "size": 10
}
```

### `POST /api/s/sessions/{id}/restore`

恢复后返回与 `/upload` 相同的负载（sessionToken、board、classification、zipUrl），**DRU 内容和校验开关（.kicad_pro）也会原样读到**——因为都持久化在 PCB 同目录。

### `DELETE /api/s/sessions/{id}`

软删除（`status=DELETED`，物理文件保留），下次上传同一文件会自动复活。

---

## 5. 完整 curl 链

```bash
BASE=http://localhost:8080
TOKEN=$(curl -s -X POST $BASE/api/s/upload -F "file=@part_placed.kicad_pcb" \
         | jq -r .sessionToken)

# 1) 读取全部校验开关
curl -s $BASE/api/s/drc-rules -H "X-Session-Token: $TOKEN" | jq '.rules[0:5]'

# 2) 保存开关：只开丝印 & 焊盘桥接，其余内置规则关掉
curl -s -X PUT $BASE/api/s/drc-rules \
  -H "X-Session-Token: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"rules":{
    "silk_edge_clearance": "error",
    "solder_mask_bridge":  "error",
    "unconnected_items":   "ignore"
  }}' | jq '.rules | map(select(.enabled)) | [.[] | {key,enabled,locked}]'

# 3) 执行校验
RESULT=$(curl -s -X POST $BASE/api/s/lint-drc -H "X-Session-Token: $TOKEN")

# 4) 看分组摘要
echo "$RESULT" | jq '.groups | map({key,count,severity,backend})'

# 5) 看 KiCad 内置违规（ruleId 为空）
echo "$RESULT" | jq '.violations | map(select(.ruleId==null)) | [.[] | {severity,message,objects}]'
```

---

## 6. 接口总览

| 方法 | 路径 | 会话 | 用途 |
|---|---|---|---|
| POST | `/api/s/upload` | （返回） | 上传解析，新建会话 |
| GET  | `/api/s/board` | ✅ | 读取解析结果 |
| GET  | `/api/s/classification` | ✅ | 读取语义分类 |
| POST | `/api/s/classification` | ✅ | 重跑分类 |
| GET  | `/api/s/drc-rules` | ✅ | 全部内置 DRC 规则开关 |
| PUT  | `/api/s/drc-rules` | ✅ | 保存开关 |
| POST | `/api/s/lint-drc` | ✅ | 主校验入口（KiCad + Native） |
| POST | `/api/s/lint` | ✅ | 仅 Native 校验 |
| GET  | `/api/s/dru` | ✅ | 当前 DRU 内容 |
| PUT  | `/api/s/dru` | ✅ | 保存用户编辑的 DRU |
| POST | `/api/s/dru/reset` | ✅ | 恢复系统生成的 DRU |
| GET  | `/api/s/download-dru` | ✅ | DRU 文件下载 |
| POST | `/api/s/generate-dru` | ✅ | 生成 DRU 并返回落盘路径 |
| GET  | `/api/s/drc-status` | ❌ | kicad-cli 可用性 |
| GET  | `/api/s/sessions` | ❌ | 历史记录分页 |
| POST | `/api/s/sessions/{id}/restore` | ❌ | 恢复历史会话 |
| DELETE | `/api/s/sessions/{id}` | ❌ | 软删除 |
| GET  | `/api/s/health` | ❌ | 健康检查 |
