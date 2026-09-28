---
name: kernel-get-snapshot
metadata:
  category: kernel
  service: KernelService
  method: GetSnapshot
  rpcKind: unary
description: >-
  Get Snapshot via KernelService.GetSnapshot
version: 0.1.0
vendor: Huaqiu Electronics
tags:
  - eda
  - huaqiu
  - kernel
entry: "@huaqiu/hqeda"
manifest: "@huaqiu/hqeda/skill.json"
inputSchema:
  name: GetSnapshotRequestSchema
  namespace: HqServicesV1KernelService
---

# Get Snapshot

Get Snapshot via KernelService.GetSnapshot

## Overview

This skill provides access to the **`KernelService.GetSnapshot`** RPC method on the Huaqiu EDA engine. It is part of the **kernel** domain and executes against the `kernel` client.

| Property | Value |
| --- | --- |
| Skill ID | `kernel-get-snapshot` |
| Service | `KernelService` |
| Method | `GetSnapshot` |
| Transport | Unary (unary) |
| Domain | kernel |
| Request type | `GetSnapshotRequest` |
| Response type | `GetSnapshotResponse` |

## Parameters

| Name | Type | Required | Repeated | Description |
| --- | --- | --- | --- | --- |
| `context` | `ProjectContext` | no | no | — |
| `atRevision` | `bigint` | yes | no | — |

## Response

Returns a `GetSnapshotResponse` message with the following fields:

| Name | Type | Repeated | Description |
| --- | --- | --- | --- |
| `snapshot` | `KernelSnapshot` | no | — |

## Usage Examples

### get kernel snapshot for a discovered project

```json
{
  "context": "<ProjectContext via client.createProjectContext('my-project')>"
}
```

## Response Example

Representative response structure (field values are placeholders):

```json
{
  "snapshot": {}
}
```

## Prerequisites

- [project-get-active-project](../../project/get-active-project/SKILL.md) — Discover the active project before building project-scoped context.

See also [skill-dependencies.md](../../references/skill-dependencies.md) for common workflows.

## How to Use

Execute via the HQ EDA skill runtime with a connected `EditorClient`. See [quickstart.md](../../references/quickstart.md) for the full `listEditors` → `connect` → `getSkill` → `execute` chain.

```typescript
import { getSkill, toJsonString } from "@huaqiu/hqeda";

const skill = getSkill("kernel-get-snapshot");
const result = await skill.execute({ client }, {
  context: "<ProjectContext via client.createProjectContext('my-project')>",
  atRevision: "0",
});
console.log(toJsonString(result, { prettySpaces: 2 }));
```

Serialize responses with `toJsonString()` — see [serialization.md](../../references/serialization.md).

## Related Skills

- Other **kernel** skills: [`kernel/`](../)
- Full index: [All EDA skills](../../SKILL.md)
- Install: `npx skills add Huaqiu-Electronics/skills --path eda/kernel/get-snapshot`

