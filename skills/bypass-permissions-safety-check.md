# bypassPermissions 模式下 SafetyCheck 自动放行与 Dotfile 删除保护

## 背景

Claude Code 的权限系统中有一层"安全检查"（safetyCheck），会对以下敏感路径的写入操作弹出用户确认：

- `.claude/` — 包含 settings、skills、commands、agents 等
- `.git/` — Git 仓库内部文件
- `.vscode/` / `.idea/` — IDE 配置
- Shell 配置文件（`.bashrc`、`.zshrc` 等）

原始设计中，safetyCheck 是 **bypass-immune** 的——即使用户开启了 `--dangerously-skip-permissions`，这些路径仍然需要手动确认。

## 修改内容

### 修改一：bypass 模式下 classifierApprovable 的 safetyCheck 自动放行

**在 `--dangerously-skip-permissions` 模式下，`classifierApprovable=true` 的 safetyCheck（如写入 `.claude/skills`）会自动放行**，并通过 `logForDebugging` 以 `warn` 级别记录审计日志。

**`classifierApprovable=false` 的 safetyCheck（如删除 dotfile、Windows 路径绕过尝试）即使在 bypass 模式下仍需用户确认。**

#### 核心修改位置

**文件**：`src/utils/permissions/permissions.ts`

**位置**：`hasPermissionsToUseToolInner()` 函数的 step 1g

```typescript
// 1g. Safety checks:
//   - classifierApprovable=true + bypass mode → auto-allow with audit log
//   - classifierApprovable=false → always prompt (even in bypass mode)
if (
  toolPermissionResult?.behavior === 'ask' &&
  toolPermissionResult.decisionReason?.type === 'safetyCheck'
) {
  const isBypassMode = ...
  if (isBypassMode && toolPermissionResult.decisionReason.classifierApprovable) {
    logForDebugging(`[bypassPermissions] Auto-approved ...`, { level: 'warn' })
    return { behavior: 'allow', ... }
  }
  return toolPermissionResult  // ← 其他情况仍弹出确认
}
```

### 修改二：删除 dotfile/dot-directory 时强制确认

**文件**：`src/tools/BashTool/pathValidation.ts`

**位置**：`checkDangerousRemovalPaths()` 函数

当 `rm`/`rmdir` 的目标文件名以 `.` 开头时（如 `.git2`、`.env`、`.ssh`），返回 `safetyCheck` 且 `classifierApprovable=false`，确保即使在 bypass 模式下也需要用户确认。

```typescript
const targetName = basename(absolutePath)
if (targetName.startsWith('.') && targetName !== '.' && targetName !== '..') {
  return {
    behavior: 'ask',
    decisionReason: {
      type: 'safetyCheck',
      reason: `${command} targets dotfile/dot-directory: ${absolutePath}`,
      classifierApprovable: false,  // ← bypass 模式也不跳过
    },
  }
}
```

## 权限系统管线（Pipeline）全景

```
hasPermissionsToUseToolInner(tool, input, context)
│
├── 1a. 全工具 deny 规则 → deny
├── 1b. 全工具 ask 规则 → ask（sandbox 可豁免）
├── 1c. tool.checkPermissions() → 工具自身的权限判断
│   └── BashTool: checkDangerousRemovalPaths()
│       ├── isDangerousRemovalPath (/, ~, /usr, etc.) → ask (type:'other')
│       └── dotfile 删除 (.git2, .env, etc.) → ask (type:'safetyCheck', classifierApprovable:false)
├── 1d. 工具返回 deny → deny
├── 1e. requiresUserInteraction → ask
├── 1f. 内容级 ask 规则（ruleBehavior:'ask'）→ ask
├── 1g. safetyCheck ← 核心修改点
│   ├── bypass 模式 + classifierApprovable=true → allow + 审计日志
│   ├── bypass 模式 + classifierApprovable=false → ask（仍需确认）
│   └── 其他模式 → ask（保持原行为）
│
├── 2a. bypassPermissions → allow
├── 2b. 全工具 allow 规则 → allow
└── 3+. acceptEdits / auto / classifier 等后续流程
```

## 关键数据流

### 场景 1：bypass 模式下写入 `.claude/skills`（自动放行）

```
FileWriteTool.checkPermissions() →
  isClaudeConfigFilePath() = true →
    checkPathSafetyForAutoEdit() → { safe: false, classifierApprovable: true } →
      step 1g: bypass + classifierApprovable=true → ✅ allow + 审计日志
```

### 场景 2：bypass 模式下删除 dotfile（仍需确认）

```
BashTool.checkPermissions() →
  checkDangerousRemovalPaths("rm", [".git2"], cwd) →
    basename = ".git2" 以 '.' 开头 →
      { behavior: 'ask', safetyCheck, classifierApprovable: false } →
        step 1g: bypass + classifierApprovable=false → ❌ 仍需确认
```

## classifierApprovable 分类汇总

| 操作 | classifierApprovable | bypass 模式行为 |
|------|---------------------|----------------|
| 写入 `.claude/skills/*` | true | ✅ 自动放行 |
| 写入 `.claude/commands/*` | true | ✅ 自动放行 |
| 写入 `.git/*` 内部文件 | true | ✅ 自动放行 |
| 写入 `.bashrc` 等 shell 配置 | true | ✅ 自动放行 |
| Windows 可疑路径写入 | false | ❌ 仍需确认 |
| `rm -rf .git2` | false | ❌ 仍需确认 |
| `rm .env` | false | ❌ 仍需确认 |
| `rmdir .ssh` | false | ❌ 仍需确认 |

## 审计日志

bypass 模式下自动放行的操作会记录 warn 级别日志：

```
[bypassPermissions] Auto-approved safety-checked operation: tool=FileWrite, reason=Claude requested permissions to write to /path/to/.claude/skills/xxx, but you haven't granted it yet.
```

日志可通过 `--debug` 标志或 `CLAUDE_DEBUG` 环境变量查看。

## 相关文件

- `src/utils/permissions/permissions.ts` — 权限管线主逻辑（step 1g）
- `src/tools/BashTool/pathValidation.ts` — `checkDangerousRemovalPaths()` dotfile 检测
- `src/utils/permissions/filesystem.ts` — `checkPathSafetyForAutoEdit()`、`isClaudeConfigFilePath()`、`isDangerousFilePathToAutoEdit()`
- `src/utils/permissions/pathValidation.ts` — `isPathAllowed()` 中调用 safetyCheck
- `src/types/permissions.ts` — `safetyCheck` 类型定义（含 `classifierApprovable` 字段）
- `src/utils/debug.ts` — `logForDebugging()` 日志工具

## 注意事项

- `checkRuleBasedPermissions()` 函数（供 hook 使用）中也有类似的 step 1g 逻辑，但它不直接处理 bypass 模式。当 hook 返回 ask 时最终仍会走 `hasPermissionsToUseToolInner()`，所以无需单独修改
- `deny` 规则和内容级 `ask` 规则（step 1d/1f）在 step 1g 之前执行，bypass 模式也无法绕过
- dotfile 删除保护使用 `basename()` 提取文件名，排除了 `.` 和 `..` 两个特殊目录

## 关联 Skill

- **smart-approve-cache** — auto mode 下持久化 LLM 分类结果，减少 `classifyYoloAction` 调用。与本 skill 在不同权限模式下独立工作（本 skill 关注 bypass 模式，SmartApprove 关注 auto 模式）
