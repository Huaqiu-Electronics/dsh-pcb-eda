# HQ EDA Skill Quickstart

End-to-end chain for running a generated skill against a live HQ EDA editor.

## Prerequisites

- HQ EDA desktop runtime running locally
- Node.js 18+
- Packages: `@huaqiu/hqeda` and `@huaqiu/huaqiu-client`

```bash
npm install @huaqiu/hqeda @huaqiu/huaqiu-client
```

## Step 1 — Discover running editors

```typescript
import { listEditors } from "@huaqiu/huaqiu-client";

const editors = await listEditors();
console.log(editors);
// [{ instanceId: "...", pid: 12345, ... }, ...]
```

When multiple editors are running, pass `instanceId` explicitly to `connect()`.

## Step 2 — Connect

```typescript
import { connect } from "@huaqiu/huaqiu-client";

const client = await connect();
// Or target a specific instance:
// const client = await connect({ instanceId: editors[0].instanceId });
```

`connect()` returns an `EditorClient` with service accessors (`client.project`, `client.edaBom`, `client.canvasOps`, …).

## Step 3 — Build context (when required)

Many RPCs require a `context` field. Build it from the connected client:

```typescript
// Editor-level context (project listing, active project discovery)
const editorContext = client.createEditorContext();

// Project-scoped context (canvas, selection, BOM for one project)
const projectContext = client.createProjectContext("my-project");
```

Obtain `projectId` via [`project-get-active-project`](../project/get-active-project/SKILL.md) or [`project-list-open-projects`](../project/list-open-projects/SKILL.md).

## Step 4 — Execute a skill

```typescript
import { getSkill, toJsonString } from "@huaqiu/hqeda";

const skill = getSkill("bom-get-bom");
if (!skill) throw new Error("Skill not found: bom-get-bom");

const result = await skill.execute(
  { client },
  { projectId: "my-project" },
);

console.log(toJsonString(result, { prettySpaces: 2 }));
```

## Step 5 — Serialize responses

Always use `toJsonString()` or `toJson()` from `@huaqiu/hqeda` — never `JSON.stringify()` directly on protobuf messages. See [serialization.md](serialization.md).

## Minimal complete script

```typescript
import { connect } from "@huaqiu/huaqiu-client";
import { getSkill, toJsonString } from "@huaqiu/hqeda";

async function main() {
  const client = await connect();
  const active = await client.project.getActiveProject({
    context: client.createEditorContext(),
  });
  const projectId = active.project?.projectId;
  if (!projectId) throw new Error("No active project");

  const skill = getSkill("bom-get-bom");
  const bom = await skill!.execute({ client }, { projectId });
  console.log(toJsonString(bom, { prettySpaces: 2 }));
}

main().catch(console.error);
```

## Install a single skill (Agent)

```bash
npx skills add Huaqiu-Electronics/skills --path eda/bom/get-bom
```
