# API Provider 检测机制

## 核心判定规则

```typescript
type APIProvider =
  | 'firstParty'
  | 'bedrock'
  | 'vertex'
  | 'foundry'
  | 'thirdParty'
  | 'codex'
```

判定逻辑（`src/utils/model/providers.ts`）：

```
CLAUDE_CODE_USE_BEDROCK=1                → 'bedrock'
CLAUDE_CODE_USE_VERTEX=1                 → 'vertex'
CLAUDE_CODE_USE_FOUNDRY=1                → 'foundry'
CLAUDE_CODE_USE_CODEX=1                  → 'codex'
ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY   → 'thirdParty'（真正的第三方 API）
ANTHROPIC_BASE_URL（无 API Key）          → 'firstParty'（OAuth 代理，等价于直连）
无 ANTHROPIC_BASE_URL                     → 'firstParty'（直连）
```

**不要把 provider 判定和策略复用混为一谈**：
- `codex` 是独立 provider，不是 `thirdParty` 的别名。
- 只有在“约束/能力”一致时，才应局部复用 `thirdParty` 的治理策略。
- 是否复用，取决于这一层到底在治理什么：认证方式、系统提示、预算压力，还是工具/skill 注入成本。

## OAuth 代理 vs 直连的等价性

| 维度 | 直连 | OAuth 代理 |
|------|------|-----------|
| `getAPIProvider()` | `firstParty` | `firstParty` |
| Prompt caching | 启用 | 启用 |
| 系统提示 | 完整 | 完整 |
| 工具数量 | 全部 ~35 | 全部 ~35 |
| 上下文窗口 | 200K | 200K |
| 输出 token | 32K/64K | 32K/64K |
| Beta headers | 全部 | 全部 |
| OAuth token | 有 | 有 |
| SDK `baseURL` | 默认 | `ANTHROPIC_BASE_URL` |

**唯一差异是 `baseURL`**，其他一切完全等价。

## 设计原则

### Principle 1: provider 判定只回答“你是谁”

`getAPIProvider()` 的职责是识别 provider 身份，不是顺手决定它应该复用谁的全部策略。

- `codex` 是独立 provider，不是 `thirdParty` 的别名。
- `thirdParty` 仍表示“Anthropic 兼容的第三方 API”。
- 是否复用某条降级/收敛路径，要看这一层治理的是认证、提示词、budget，还是工具/skill 注入成本。

### Principle 2: 按能力与约束复用，不按 provider 名扩散

不推荐在越来越多调用点复制：

```typescript
if (provider === 'thirdParty' || provider === 'codex') {
  // ...
}
```

更推荐把复用语义抽成 helper，例如：

```typescript
if (shouldUseConservativePlanPrompt(provider)) {
  // plan mode 治理
}

if (shouldBudgetAllToolResults(provider)) {
  // prompt cache / budget 治理
}
```

这样能避免后续把“provider 身份”与“约束相似时的局部复用”混在一起。

## `thirdParty` 触发的降级（仅影响真正的第三方 API）

| 降级项 | 文件 | 函数 | 逃生口 |
|--------|------|------|--------|
| 禁用 prompt caching | `src/services/api/claude.ts` | `getPromptCachingEnabled()` | - |
| 精简系统提示 ~2K chars | `src/constants/prompts.ts` | `getSystemPrompt()` | `CLAUDE_CODE_FULL_SYSTEM_PROMPT=1` |
| 裁剪工具至 ~13 个 | `src/tools.ts` | `getTools()` | `CLAUDE_CODE_FULL_TOOLS=1` |
| 上下文窗口 128K | `src/utils/context.ts` | `getContextWindowForModel()` | `CLAUDE_CODE_MAX_CONTEXT_TOKENS=N` |
| 输出 token 16K/32K | `src/utils/context.ts` | `getMaxOutputTokens()` | - |
| 跳过 Anthropic beta headers | `src/utils/betas.ts` | `getBetaHeaders()` | - |
| 跳过 API metadata | `src/services/api/claude.ts` | `sendRequest()` | - |

详见 `skills/third-party-performance-tuning.md` 了解每项优化的详细说明和调优方法。

## `isProxyMode()` 辅助函数

```typescript
// true: 设置了 ANTHROPIC_BASE_URL 且非 Anthropic 官方域名
// 不区分 firstParty 还是 thirdParty
isProxyMode(): boolean
```

用于 OAuth URL 代理构建（`src/constants/oauth.ts`）等需要知道"是否走代理"但不关心 provider 类型的场景。

## 认证模式切换标志

启动链中有两个互为镜像的标志，在 settings.json env 注入**之前**设置，控制 `applySafeConfigEnvironmentVariables` 的清理行为：

| 标志 | 设置时机 | 作用 | 触发条件 |
|------|---------|------|---------|
| `CLAUDE_FORCE_OAUTH` | `main.tsx:599` | 删除所有第三方 API 变量，强制 OAuth | `--force-oauth` 启动参数 |
| `CLAUDE_API_MODE` | `main.tsx:616` | 恢复 shell 原始 `BASE_URL`，忽略 settings 注入的 OAuth 代理 URL | shell 环境存在 `ANTHROPIC_API_KEY` |

**`CLAUDE_API_MODE` 的完整流程**：

```
main() 启动
  ↓ shell 有 ANTHROPIC_API_KEY？
  ↓ 是 → CLAUDE_API_MODE=1, 快照 shell BASE_URL → _CLAUDE_API_MODE_BASE_URL
  ↓
applySafeConfigEnvironmentVariables()
  ↓ Object.assign(process.env, settings.env)  ← settings 中的代理 URL 覆盖了 shell 值
  ↓
  ↓ CLAUDE_API_MODE=1？
  ↓ 是 → _CLAUDE_API_MODE_BASE_URL 非空？恢复 : 删除 ANTHROPIC_BASE_URL
  ↓
getAPIProvider() 判定
  ↓ 无 BASE_URL → firstParty (SDK 默认)
  ↓ 有 BASE_URL (shell 原始值, 如 minimax) + 有 API_KEY → thirdParty
```

**关键文件**：
- `src/main.tsx:610-620` — 标志设置 + shell 快照
- `src/utils/managedEnv.ts:190-200` — settings 注入后恢复/清除

详见 `skills/auth-mode-switching.md` 了解完整的模式切换架构。

## 常见陷阱

### 陷阱 1: ANTHROPIC_MODEL 不影响 provider 判定

```bash
# ✅ 这是 OAuth 代理用户（firstParty），ANTHROPIC_MODEL 只是模型偏好
ANTHROPIC_BASE_URL="http://proxy/..." ANTHROPIC_MODEL="claude-opus-4-6" claude
```

### 陷阱 2: 新增 Provider 类型时的检查清单

- [ ] `Record<APIProvider, T>`（如 `ModelConfig`）
- [ ] `if (provider === 'xxx')` 守卫条件
- [ ] Beta header 构建
- [ ] SDK client 认证
- [ ] 认证状态检测

### 陷阱 3: `!== 'firstParty'` ≠ `=== 'thirdParty'`

```typescript
// ❌ 影响 bedrock/vertex/foundry/codex
if (getAPIProvider() !== 'firstParty') { /* 降级 */ }

// ✅ 只影响第三方 API
if (getAPIProvider() === 'thirdParty') { /* 降级 */ }
```

### 陷阱 4: Codex ≠ thirdParty

```typescript
// ❌ 不问"治理什么约束"就直接并列
if (provider === 'thirdParty' || provider === 'codex') { /* 所有降级 */ }

// ✅ 区分约束类型
if (shouldBudgetAllToolResults(provider)) { /* 预算约束 */ }
if (shouldUseConservativePlanPrompt(provider)) { /* plan 倾向约束 */ }
```

详见 [codex-interaction-profile.md](codex-interaction-profile.md) 了解 Codex 的完整交互轮廓。
