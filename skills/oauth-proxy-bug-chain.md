# OAuth 代理 Bug 链诊断手册

## 诊断流程

```
启动 Claude Code
  ↓
提示 "Not logged in"
  → 检查 isAnthropicAuthEnabled() 是否返回 true
  → 确认 settings.json 无 ANTHROPIC_API_KEY（会禁用 OAuth）
  ↓
/login 后崩溃 "modelInput.trim"
  → parseUserSpecifiedModel() 空值防御
  ↓
/login 成功但对话仍 "Not logged in"
  → 检查 client.ts 是否正确传递 authToken
  → 检查 betas.ts 是否包含 oauth-2025-04-20 header
  ↓
对话 404 / model=undefined
  → 检查 configs.ts 的 thirdParty 字段
  → 确认 getAPIProvider() 返回 'firstParty'（非 'thirdParty'）
  ↓
功能降级（工具少、提示精简）
  → 确认 getAPIProvider() 返回 'firstParty'
  → 如返回 'thirdParty' 则检查是否误设了 ANTHROPIC_API_KEY
```

## 5 环 Bug 链速查

| Bug | 现象 | 文件 | 根因 |
|-----|------|------|------|
| 1 | OAuth 被禁用 | `auth.ts:100` | `ANTHROPIC_BASE_URL` 存在即禁用 |
| 2 | modelInput.trim() 崩溃 | `model.ts:476` | 空值未防御 |
| 3 | Token 未注入 | `client.ts:310` | `customBaseUrl` 时 authToken 为 undefined |
| 4 | OAuth beta header 缺失 | `betas.ts:244` | thirdParty 跳过所有 beta |
| 5 | 模型名 undefined | `configs.ts` | ModelConfig 无 thirdParty 字段 |
| **根本** | Provider 误判 | `providers.ts:12` | 代理 URL = thirdParty |

**根本修复**：`providers.ts` 中无 `ANTHROPIC_API_KEY` 时返回 `firstParty`，消除全部 5 个 bug 的根因。

## 代理日志关键字

| 日志 | 含义 | 对应 Bug |
|------|------|---------|
| 仅 `HEAD` 探测 | OAuth 被禁用 | Bug 1 |
| 无 `Authorization` header | Token 未注入 | Bug 3 |
| `"OAuth authentication is currently not supported"` | 缺 beta header | Bug 4 |
| `model=undefined` | 模型名未解析 | Bug 5 |
| 401 + Bearer token | beta header 或 token 问题 | Bug 3/4 |
| 404 | 模型不存在 | Bug 5 |

## 自动保护: CLAUDE_API_MODE

当 shell 环境存在 `ANTHROPIC_API_KEY` 时，启动链自动设置 `CLAUDE_API_MODE=1`，
**忽略 settings.json 中的 OAuth 代理 URL**，避免 API 请求被发往代理：

```
main() 启动
  ↓ shell 有 ANTHROPIC_API_KEY？
  ↓ 是 → CLAUDE_API_MODE=1, 快照 shell BASE_URL
  ↓
applySafeConfigEnvironmentVariables()
  ↓ settings.env 注入（可能包含代理 URL）
  ↓ CLAUDE_API_MODE → 恢复 shell 原始 BASE_URL 或删除 settings 注入的代理 URL
  ↓
getAPIProvider() → 基于 shell 原始值判定，不受 settings 代理干扰
```

**关键文件**：`src/main.tsx:610-620`（标志设置）、`src/utils/managedEnv.ts:190-200`（恢复逻辑）

这意味着下面"会导致问题的配置"在 shell 设置 API_KEY 时**不再触发**——
CLAUDE_API_MODE 会自动清除 settings 注入的代理 URL。

## 配置检查

**正确的 OAuth 代理配置**（settings.json）：
```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:8002/api/v1/proxy/anthropic"
  }
}
```

**会导致问题的配置**（仅当 settings.json 中同时设置时仍有风险）：
```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:8002/...",
    "ANTHROPIC_API_KEY": "sk-xxx",        // ← 会变成 thirdParty！
    "ANTHROPIC_AUTH_TOKEN": "sk-xxx"       // ← 会走 API Key 认证路径
  }
}
```

> **注意**：`CLAUDE_API_MODE` 仅保护 **shell 环境设置 API_KEY** 的场景。
> 如果 `ANTHROPIC_API_KEY` 也来自 settings.json（而非 shell），则不受保护——
> 此时应使用 `--force-oauth` 强制回到 OAuth 模式。

## 验证命令

```bash
# 检查 provider
ANTHROPIC_BASE_URL="http://localhost:8002/..." \
bun -e "const{getAPIProvider}=require('./src/utils/model/providers.ts');console.log(getAPIProvider())"
# 期望输出: firstParty

# 测试代理连通性
curl -I http://localhost:8002/api/v1/proxy/anthropic

# 测试 profile 端点
curl http://localhost:8002/api/v1/proxy/anthropic/api/oauth/profile \
  -H "Authorization: Bearer sk-ant-oat01-xxx"
```

## 经验教训

1. **有 API Key = thirdParty，无 API Key = firstParty**——唯一判定规则
2. **代理 ≠ 第三方**——代理只是转发，后端仍是 Anthropic
3. **ANTHROPIC_MODEL 不影响 provider**——仅为模型偏好
4. **代理日志是最可靠的诊断工具**——每个 bug 都能从日志精确定位
