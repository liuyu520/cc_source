# 认证模式切换架构

## 核心概念: 镜像模式

启动链提供两个**互为镜像**的认证模式切换机制，在 settings.json env 注入之前设置标志，
在 `applySafeConfigEnvironmentVariables()` 注入之后执行清理，确保整个生命周期内模式一致。

```
                    ┌─────────────────────┐
                    │     main() 启动      │
                    └──────────┬──────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                                  ▼
    --force-oauth 参数？              shell 有 ANTHROPIC_API_KEY？
              │                                  │
         ┌────┴────┐                        ┌────┴────┐
         │  是     │                        │  是     │
         ▼         ▼                        ▼         ▼
  CLAUDE_FORCE_OAUTH=1            CLAUDE_API_MODE=1
  删除 BASE_URL/API_KEY/          快照 shell BASE_URL →
  AUTH_TOKEN/Bedrock/Vertex/      _CLAUDE_API_MODE_BASE_URL
  Foundry
         │                                  │
         └────────────────┬─────────────────┘
                          ▼
            applySafeConfigEnvironmentVariables()
            Object.assign(process.env, settings.env)
            ← settings 中的代理 URL 可能覆盖 shell 值
                          │
              ┌───────────┼───────────┐
              ▼                        ▼
    CLAUDE_FORCE_OAUTH？      CLAUDE_API_MODE？
              │                        │
    删除 BASE_URL/API_KEY/    恢复 shell 原始 BASE_URL
    AUTH_TOKEN/Bedrock/       或删除 settings 注入的
    Vertex/Foundry            代理 URL
              │                        │
              └───────────┬────────────┘
                          ▼
                 getAPIProvider() 判定
```

## 两个标志对比

| 维度 | `CLAUDE_FORCE_OAUTH` | `CLAUDE_API_MODE` |
|------|---------------------|-------------------|
| **方向** | 第三方 API → 官方 OAuth | OAuth 代理 → 直连 API |
| **触发** | `--force-oauth` 启动参数 | shell 存在 `ANTHROPIC_API_KEY` |
| **标志设置** | `main.tsx:599-608` | `main.tsx:610-620` |
| **清理位置** | `managedEnv.ts:179-188` | `managedEnv.ts:190-200` |
| **清理动作** | 删除所有第三方 API 变量 | 恢复 shell 原始 `BASE_URL` 或删除 |
| **保护范围** | 阻止 settings 重新注入 API 配置 | 阻止 settings 代理 URL 覆盖 shell 值 |
| **互斥** | 优先级更高（先检查） | `CLAUDE_FORCE_OAUTH` 存在时跳过 |

## 关键实现

### main.tsx（标志设置，早于任何 settings 加载）

```typescript
// 位置: main.tsx:594-620（两段紧邻）

// 段 1: --force-oauth（从第三方切回 OAuth）
if (process.argv.includes('--force_oauth') || process.argv.includes('--force-oauth')) {
  process.env.CLAUDE_FORCE_OAUTH = '1'
  delete process.env.ANTHROPIC_BASE_URL
  delete process.env.ANTHROPIC_API_KEY
  // ... 删除所有第三方变量
}

// 段 2: API 模式自动检测（从 OAuth 代理切到直连 API）
if (!process.env.CLAUDE_FORCE_OAUTH && process.env.ANTHROPIC_API_KEY) {
  process.env.CLAUDE_API_MODE = '1'
  process.env._CLAUDE_API_MODE_BASE_URL = process.env.ANTHROPIC_BASE_URL || ''
}
```

### managedEnv.ts（settings 注入后清理）

```typescript
// 位置: managedEnv.ts:179-200（两段紧邻）

// 段 1: --force-oauth 清理
if (process.env.CLAUDE_FORCE_OAUTH) {
  delete process.env.ANTHROPIC_BASE_URL
  // ... 删除所有第三方变量
}

// 段 2: API 模式清理
if (process.env.CLAUDE_API_MODE) {
  const shellBaseUrl = process.env._CLAUDE_API_MODE_BASE_URL
  if (shellBaseUrl) {
    process.env.ANTHROPIC_BASE_URL = shellBaseUrl  // 恢复 shell 值
  } else {
    delete process.env.ANTHROPIC_BASE_URL          // 清除 settings 注入的代理 URL
  }
}
```

## 场景矩阵

### 场景 1: OAuth 代理用户（默认模式）

```bash
# settings.json: { "env": { "ANTHROPIC_BASE_URL": "http://proxy:8002/..." } }
# shell: 无 API_KEY
claude
```

- 无标志触发 → settings 代理 URL 正常生效 → `firstParty` (OAuth 代理)

### 场景 2: API Key 用户 + settings 有代理 URL

```bash
# settings.json: { "env": { "ANTHROPIC_BASE_URL": "http://proxy:8002/..." } }
# shell:
export ANTHROPIC_API_KEY="minimax-key"
export ANTHROPIC_BASE_URL="https://api.minimaxi.com/anthropic"
claude
```

- `CLAUDE_API_MODE=1`，快照 `https://api.minimaxi.com/anthropic`
- settings 注入后代理 URL 覆盖 → 清理恢复为 `https://api.minimaxi.com/anthropic`
- `thirdParty` (MiniMax API)

### 场景 3: API Key 用户 + 不设 BASE_URL

```bash
# settings.json: { "env": { "ANTHROPIC_BASE_URL": "http://proxy:8002/..." } }
# shell:
export ANTHROPIC_API_KEY="sk-ant-xxx"
claude
```

- `CLAUDE_API_MODE=1`，快照空字符串
- settings 注入后代理 URL 出现 → 清理删除 → SDK 用默认 `api.anthropic.com`
- `firstParty` (API Key 直连)

### 场景 4: --force-oauth 强制回 OAuth

```bash
export ANTHROPIC_API_KEY="minimax-key"
export ANTHROPIC_BASE_URL="https://api.minimaxi.com/anthropic"
claude --force-oauth
```

- `CLAUDE_FORCE_OAUTH=1`，删除 API_KEY + BASE_URL
- `CLAUDE_API_MODE` 不触发（`FORCE_OAUTH` 优先）
- `firstParty` (OAuth 直连)

### 场景 5: 备用 API 切换（运行时）

```bash
# 正常 OAuth 使用中，遇到 429 限流
# switchToBackupApiConfig() 直接覆盖 process.env
```

- 运行时直接设置 `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY`
- 不经过 `applySafeConfigEnvironmentVariables`，`CLAUDE_API_MODE` 清理不干扰
- 备用 API 正常工作

## 与备用 API Fallback 的关系

```
启动时标志          运行时直接覆盖          设置变更重新注入
─────────────      ──────────────       ──────────────────
CLAUDE_FORCE_OAUTH  switchToBackup()     applySafeConfig()
CLAUDE_API_MODE     直接改 process.env   ← 标志清理在这里生效
```

- `switchToBackupApiConfig()` 直接操作 `process.env`，不触发 `applySafeConfigEnvironmentVariables`
- 如果后续 settings 变更触发重新注入，`CLAUDE_API_MODE` 清理会恢复 shell 原始值
  （但此时备用 API 已在 `process.env` 中，且 `_backupActivated` 标志阻止重复切换）

## 新增模式切换的检查清单

如果需要新增类似的模式切换机制（如 `CLAUDE_BEDROCK_MODE`）：

- [ ] `main.tsx`: 在 `--force-oauth` / `CLAUDE_API_MODE` 之后添加标志设置
- [ ] `main.tsx`: 确保与现有标志互斥（先 force-oauth → 再 api-mode → 再新标志）
- [ ] `managedEnv.ts`: 在 `applySafeConfigEnvironmentVariables()` 末尾添加清理逻辑
- [ ] `managedEnv.ts`: 清理顺序与 `main.tsx` 标志设置顺序一致
- [ ] 验证与 `switchToBackupApiConfig()` 运行时覆盖不冲突
- [ ] 更新 `skills/api-provider-detection.md` 的标志表
- [ ] 更新 `skills/third-party-api-setup.md` 的场景矩阵

## 关键文件

| 文件 | 职责 |
|------|------|
| `src/main.tsx:594-620` | 标志设置（`--force-oauth` + `CLAUDE_API_MODE`） |
| `src/utils/managedEnv.ts:179-200` | settings 注入后清理 |
| `src/utils/model/providers.ts:7-28` | `getAPIProvider()` 基于清理后的 env 判定 |
| `src/utils/auth.ts:100-105` | `isAnthropicAuthEnabled()` 认证启用判定 |
| `src/utils/backupApiConfig.ts` | 运行时备用 API 切换（独立于启动时标志） |
