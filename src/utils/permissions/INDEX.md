# `src/utils/permissions/` 模块索引

## 模块定位

`src/utils/permissions/` 是权限系统核心，负责权限模式、规则解析、自动批准、拒绝跟踪、文件系统边界与 LLM/classifier 辅助审批。

## 关键文件

- `permissionSetup.ts`
  权限上下文初始化与模式装配
- `permissions.ts`
  核心权限判断
- `PermissionMode.ts`
  权限模式定义
- `filesystem.ts`
  文件系统权限边界
- `permissionsLoader.ts`
  规则装载

## 主要文件分组

### 模式与状态

- `PermissionMode.ts`
- `autoModeState.ts`
- `getNextPermissionMode.ts`
- `denialTracking.ts`
- `bypassPermissionsKillswitch.ts`

### 规则系统

- `PermissionRule.ts`
- `permissionRuleParser.ts`
- `permissionsLoader.ts`
- `shellRuleMatching.ts`
- `shadowedRuleDetection.ts`

### 分类与解释

- `bashClassifier.ts`
- `yoloClassifier.ts`
- `classifierDecision.ts`
- `classifierShared.ts`
- `permissionExplainer.ts`
- `repetitionDetector.ts`

### 文件与路径

- `filesystem.ts`
- `pathValidation.ts`
- `dangerousPatterns.ts`

### Schema / 更新协议

- `PermissionResult.ts`
- `PermissionUpdate.ts`
- `PermissionPromptToolResultSchema.ts`
- `PermissionUpdateSchema.ts`

### Prompt 资产

- `yolo-classifier-prompts/`
  包含 `auto_mode_system_prompt.txt`、`permissions_anthropic.txt`、`permissions_external.txt`

## 关联模块

- Bash 工具： [../../tools/BashTool/INDEX.md](../../tools/BashTool/INDEX.md)
- 权限 UI： [../../components/permissions/INDEX.md](../../components/permissions/INDEX.md)
