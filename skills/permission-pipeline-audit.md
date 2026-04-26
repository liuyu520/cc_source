# 权限管道审计日志 — 安全决策可回溯

## 问题根因

`hasPermissionsToUseToolInner` 有 11 个 early return 点，但只有 2 个带日志。短路返回导致后续检查器不执行，无法回溯：
- 为什么这个操作被允许了？
- 哪个检查器做出了决策？
- auto mode 分类器是否被调用了？

## 核心模式: 统一出口审计（非逐点日志）

**不在 11 个 return 点分别加日志**（侵入性太强），而是在两个关键出口添加统一审计：

```
hasPermissionsToUseTool (外层)
  └→ hasPermissionsToUseToolInner (11 个 return 点)
     └→ [审计点 1] 规则层决策 ← 记录 inner 的裸结果
  └→ auto mode 处理
     └→ acceptEdits 快速路径
     └→ 白名单检查
     └→ SmartApprove 缓存
     └→ classifyYoloAction (LLM 分类器)
        └→ [审计点 2] 分类器决策 ← 记录最终结果
```

### 审计点 1: 规则层决策

在 `hasPermissionsToUseToolInner` 返回后立即记录：

```typescript
// 权限管道审计日志：记录规则层决策
logForDebugging(
  `[PermissionAudit] tool=${tool.name} behavior=${result.behavior} reason=${result.decisionReason?.type ?? 'none'}...`,
)
```

记录内容：
- `tool` — 工具名
- `behavior` — allow / ask / deny
- `reason` — 决策原因类型（rule / safetyCheck / mode / other）
- 条件信息：rule 时输出 source，safetyCheck 时输出 classifierApprovable

### 审计点 2: 分类器最终决策

在 `classifyYoloAction` 返回后记录：

```typescript
// 权限管道审计日志：分类器最终决策
logForDebugging(
  `[PermissionAudit:final] tool=${tool.name} classifierDecision=... mode=...`,
)
```

记录内容：
- `tool` — 工具名
- `classifierDecision` — unavailable / blocked / allowed
- `mode` — 当前权限模式（auto / plan 等）
- `reason` — 分类器给出的原因

### 审计日志示例

```
# 正常 allow（白名单）
[PermissionAudit] tool=Read behavior=allow reason=mode

# 需要确认（安全检查）
[PermissionAudit] tool=FileWrite behavior=ask reason=safetyCheck classifierApprovable=true

# auto mode 分类器放行
[PermissionAudit] tool=Bash behavior=ask reason=none
[PermissionAudit:final] tool=Bash classifierDecision=allowed mode=auto

# auto mode 分类器阻止
[PermissionAudit] tool=Bash behavior=ask reason=none
[PermissionAudit:final] tool=Bash classifierDecision=blocked mode=auto reason=Destructive command
```

## 设计决策

| 决策 | 理由 |
|------|------|
| 使用 `logForDebugging` 不用 `logEvent` | 审计是调试回溯，不是遥测。`logEvent` 需要隐私审计标记 |
| 两点审计而非逐点 | 11 个 return 点逐个加日志侵入性太强，且维护成本高 |
| 不记录完整 input | input 可能包含敏感内容（代码、路径），只记录工具名 |
| debug 级别不用 warn | 正常决策不应产生告警噪音 |

## 与 hasPermissionsToUseToolInner 11 个 return 点的关系

| # | 检查阶段 | behavior | 审计覆盖 |
|---|----------|----------|---------|
| 1 | abort signal | 抛异常 | N/A |
| 2 | deny rule | deny | ✅ 审计点 1 |
| 3 | ask rule | ask | ✅ 审计点 1 |
| 4 | tool.checkPermissions → deny | deny | ✅ 审计点 1 |
| 5 | requiresUserInteraction | ask | ✅ 审计点 1 |
| 6 | 内容级 ask 规则 | ask | ✅ 审计点 1 |
| 7 | safetyCheck + bypass + approvable | allow | ✅ 审计点 1 |
| 8 | safetyCheck 其他 | ask | ✅ 审计点 1 |
| 9 | bypassPermissions | allow | ✅ 审计点 1 |
| 10 | toolAlwaysAllowedRule | allow | ✅ 审计点 1 |
| 11 | passthrough → ask | ask | ✅ 审计点 1 |

所有 return 点都被审计点 1 覆盖。经过 auto mode 分类器的路径额外被审计点 2 覆盖。

## 关键文件

| 文件 | 修改 | 位置 |
|------|------|------|
| `src/utils/permissions/permissions.ts` | 审计点 1 | `hasPermissionsToUseToolInner` 调用后 |
| `src/utils/permissions/permissions.ts` | 审计点 2 | `classifyYoloAction` 返回后 |

## 查看审计日志

通过 `--debug` 标志或 `CLAUDE_DEBUG` 环境变量启用：

```bash
CLAUDE_DEBUG=1 claude
# 或
claude --debug
```

日志输出到 `~/.claude/debug.log`（取决于 `logForDebugging` 的输出配置）。

## 关联 Skill

- **bypass-permissions-safety-check** — 描述权限管线全景，本 skill 补充审计层
- **smart-approve-cache** — SmartApprove 缓存命中也被审计点 1 覆盖
