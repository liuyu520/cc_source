# 第三方 API 与 OAuth 代理配置指南

## 两种使用场景

### 场景 1: OAuth 代理（Anthropic 套餐用户）

通过代理访问 Anthropic 官方 API，使用 Claude Pro/Max/Team/Enterprise 订阅：

```bash
# 只设置代理 URL，不设置 API Key → getAPIProvider() 返回 'firstParty'
export ANTHROPIC_BASE_URL="http://localhost:8002/api/v1/proxy/anthropic"
claude
# 运行 /login 进行 OAuth 登录
```

**行为与直连完全等价**：完整系统提示、全部工具、200K 上下文、prompt caching 启用。

可选：指定模型偏好（不影响 provider 判定）：
```bash
export ANTHROPIC_MODEL="claude-opus-4-6"  # 仅为模型偏好
```

### 场景 2: 第三方 API（MiniMax 等）

使用非 Anthropic 的第三方 API：

```bash
# 设置了 API Key → getAPIProvider() 返回 'thirdParty'
export ANTHROPIC_BASE_URL="https://api.minimaxi.com/anthropic"
export ANTHROPIC_API_KEY="your-api-key"
export ANTHROPIC_MODEL="MiniMax-M2.7"
claude
```

**自动性能优化**：精简提示、裁剪工具、降低 token 限制、禁用缓存。

## 判定规则

| ANTHROPIC_BASE_URL | ANTHROPIC_API_KEY | Provider | 认证方式 |
|-------------------|-------------------|----------|---------|
| 无 | 无 | firstParty | OAuth 直连 |
| `http://proxy/...` | 无 | **firstParty** | OAuth 代理 |
| `http://proxy/...` | `sk-xxx` | thirdParty | API Key |
| `https://minimax/...` | `key` | thirdParty | API Key |

**核心逻辑**：有 API Key = thirdParty，无 API Key = firstParty。

### 场景 3: API 模式自动检测（CLAUDE_API_MODE）

当 settings.json 中配置了 OAuth 代理 URL，但 shell 环境提供了 API Key 时，
系统**自动忽略** settings 中的代理 URL，避免 API 请求被发往 OAuth 代理：

```bash
# ~/.claude/settings.json 中有:
#   "env": { "ANTHROPIC_BASE_URL": "http://43.135.170.102:8002/api/v1/proxy/anthropic" }

# shell 中设置 API Key → 自动触发 CLAUDE_API_MODE
export ANTHROPIC_API_KEY="your-minimax-key"
export ANTHROPIC_BASE_URL="https://api.minimaxi.com/anthropic"  # 可选
export ANTHROPIC_MODEL="MiniMax-M2.7"
claude
```

**行为**：
- `main()` 检测到 shell 有 `ANTHROPIC_API_KEY`，设置 `CLAUDE_API_MODE=1`，快照 shell 的 `ANTHROPIC_BASE_URL`
- `applySafeConfigEnvironmentVariables()` 应用 settings 后，恢复 shell 原始 `BASE_URL`（或清除 settings 注入的代理 URL）
- 最终 `getAPIProvider()` 基于 shell 原始值判定，不受 settings 中代理 URL 干扰

| shell 设置 | settings.json | 最终 BASE_URL | Provider |
|-----------|---------------|--------------|----------|
| `API_KEY` + `BASE_URL=minimax` | 代理 URL | `https://api.minimaxi.com/...` | thirdParty |
| `API_KEY`（无 BASE_URL） | 代理 URL | 无（SDK 默认） | firstParty |
| 无 API_KEY | 代理 URL | 代理 URL | firstParty (OAuth) |

**与 `--force-oauth` 互为镜像**：force-oauth 从第三方切回 OAuth，CLAUDE_API_MODE 从 OAuth 代理切到直连 API。

详见 `skills/auth-mode-switching.md`。

## OAuth 代理需要的端点

代理服务器需转发以下请求到对应的 Anthropic 域名：

```
POST /v1/oauth/token             → platform.claude.com
GET  /oauth/authorize            → platform.claude.com
GET  /cai/oauth/authorize        → claude.com
GET  /api/oauth/profile          → api.anthropic.com
GET  /api/oauth/claude_cli/roles → api.anthropic.com
POST /v1/messages                → api.anthropic.com
```

**不走代理**（浏览器回调页面）：
- `/oauth/code/callback` → 始终 `platform.claude.com`
- `/oauth/code/success` → 始终 `platform.claude.com`

## 第三方 API 性能优化逃生口

```bash
export CLAUDE_CODE_FULL_TOOLS=1              # 完整工具集
export CLAUDE_CODE_FULL_SYSTEM_PROMPT=1      # 完整系统提示
export CLAUDE_CODE_MAX_CONTEXT_TOKENS=200000 # 自定义上下文窗口
```

## 关键代码位置

| 功能 | 文件 |
|------|------|
| Provider 判定 | `src/utils/model/providers.ts:7-28` |
| OAuth 启用控制 | `src/utils/auth.ts:100-105` |
| SDK client 认证 | `src/services/api/client.ts:300-335` |
| OAuth beta header | `src/utils/betas.ts:244-253` |
| 模型名映射 | `src/utils/model/configs.ts` |
| OAuth URL 代理 | `src/constants/oauth.ts:85-120` |
| Prompt caching | `src/services/api/claude.ts:333-338` |
| 工具集过滤 | `src/tools.ts:303` |
| 系统提示精简 | `src/constants/prompts.ts:477` |
