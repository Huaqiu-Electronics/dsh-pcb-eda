# AddSchematicToActiveProject — 引擎落地清单

Skill / scenario-b 文档已就绪。**手写 C++/proto 已合入仓库**；你仍需本地 **proto → pb/grpc（及 TS SDK）** 后再编译 Jupiter / 跑 `pnpm capability:generate`。

## 1. Proto（两处同步） — 已完成

## 2. 生成（你手动）

- hq-edge / jupiter2：proto → C++ pb/grpc + TS SDK（`platform/sdk/ts/src/generated`）
- jupiter2：`gen_project_grpc_run.ps1` 已增 HandlerSpec；**不必**重跑（handlers.inc / methods.inc / Jupiter_2.h 已手改）

```powershell
@("AddSchematicToActiveProject","AddSchematicToActiveProjectRequest","AddSchematicToActiveProjectResponse","ADD_SCHEMATIC_TO_ACTIVE_PROJECT_REQUEST","ADD_SCHEMATIC_TO_ACTIVE_PROJECT_RESPONSE","DeserializeAddSchematicToActiveProjectRequest","SerializeAddSchematicToActiveProjectResponse","addSchematicToActiveProjectByRPC"),
```

## 3. serialize_data.h — 已完成

```cpp
struct ADD_SCHEMATIC_TO_ACTIVE_PROJECT_REQUEST
{
	std::string schematic_name;
};

struct ADD_SCHEMATIC_TO_ACTIVE_PROJECT_RESPONSE
{
	int32_t error_code = 0;
	std::string schematic_name;
};
```

## 4. sch_SDK.h / sch_SDK.cpp — 已完成

```cpp
enum class SchAddSchematicError
{
	None = 0,
	NoMainWindow,
	NoActiveProject,
	NotProjectWorkspace,
	InvalidSchematicName,
	SchematicAlreadyExists,
};

JUPITERCORE_EXPORT SchAddSchematicError SCH_AddSchematicToActiveProject(
	Jupiter_2* pMainWindow,
	const char* schematicNameUtf8,
	std::string* pCreatedSchematicNameUtf8 = nullptr);
```

## 5. project_jupiter_slots.cpp — 已完成

```cpp
void Jupiter_2::addSchematicToActiveProjectByRPC(
    std::shared_ptr<HqEdaProto::ADD_SCHEMATIC_TO_ACTIVE_PROJECT_REQUEST> request,
    std::shared_ptr<HqEdaProto::ADD_SCHEMATIC_TO_ACTIVE_PROJECT_RESPONSE> response)
{
    if (!request || !response) return;
    response->error_code = static_cast<int32_t>(SchAddSchematicError::NoMainWindow);
    response->schematic_name.clear();
    std::string created;
    const SchAddSchematicError error = SCH_AddSchematicToActiveProject(
        this, request->schematic_name.c_str(), &created);
    response->error_code = static_cast<int32_t>(error);
    if (error == SchAddSchematicError::None)
        response->schematic_name = created;
}
```

## 6. convert / project_service.* / Jupiter_2.h — 已完成

## 7. hq-edge 收尾

1. proto 进 TS SDK 后：`pnpm capability:generate`（根目录）
2. 改 `skills/hqeda/scripts/build-scenario-b-package.mjs` rpc 数组（create/add-schematic/add-page/activate/list-tree）
3. 改 `onboarding/scenario-b/template/scripts/probe-rpc.ts` 增加 `project.addSchematicToActiveProject`
4. `pnpm run build:scenario-b`

## 9. 验证

活跃工程 → RPC 创建 schematic → `ListProjectTree` 见新节点（无页）→ `AddPageToProject` + `ActivatePageInProject` 成功。
