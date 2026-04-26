import { registerBundledSkill } from '../bundledSkills.js'

const OAUTH_PROXY_PROMPT = `# OAuth Proxy Architecture

本项目支持通过用户自建的 **OAuth 代理** 转发 Anthropic API 请求。与直接使用
第三方 API（MiniMax 等需要 API Key 的独立服务）不同，OAuth 代理是一个透传
层——接收带 OAuth Bearer token 的请求，转发到 \`api.anthropic.com\`。

## 典型架构

\`\`\`
 CLI (自动 / 手动激活 force-oauth)
   ↓ OAuth Bearer token
 ANTHROPIC_BASE_URL = http://your-proxy/api/v1/proxy/anthropic
   ↓ 透传 Authorization: Bearer xxx
 api.anthropic.com / platform.claude.com / claude.com
   ↓ 响应
 your-proxy → CLI
\`\`\`

**所有请求统一走代理**——包括 OAuth 控制面（authorize/token/roles/profile）
和数据面（/v1/messages）。代理需要能转发到对应的 Anthropic 后端服务。

## 触发条件（二选一，自动复用同一条 CLAUDE_FORCE_OAUTH 通路）

1. **URL 约定（隐式触发，推荐）**：\`ANTHROPIC_BASE_URL\` 的 **pathname 包含相邻
   的 \`v1\` + \`proxy\` 两段**（通过 \`isOauthProxyBaseUrl()\` 判定）。shell env
   或 settings.json 中配置都适用，无需其他参数。代码在 \`main.tsx\`（shell env）
   和 \`managedEnv.ts\` 两个 apply 入口（settings.json）分别检测，自动置
   \`CLAUDE_FORCE_OAUTH=1\`。
2. **CLI 参数 / 环境变量**：\`--force-oauth\` / \`export CLAUDE_FORCE_OAUTH=1\`

### 匹配规则（严格按路径段，避免误伤）

\`isOauthProxyBaseUrl(url)\` 用 \`new URL().pathname.split('/').filter(Boolean)\`
切段后查找相邻的 \`v1\` + \`proxy\`：

| URL | 命中 | 说明 |
|-----|------|------|
| \`https://proxy.example.com/v1/proxy/anthropic\` | ✓ | 标准代理路径 |
| \`https://example.com/v1/proxy\` | ✓ | 裸段 |
| \`https://example.com/gateway/v1/proxy/foo\` | ✓ | 嵌套在 host 前缀下 |
| \`http://host/api/v1/proxy/anthropic\` | ✓ | 多层前缀 |
| \`https://example.com/api/v1/proxy_old\` | ✗ | \`proxy_old\` ≠ \`proxy\` |
| \`https://example.com/v1/proxyfoo\` | ✗ | \`proxyfoo\` ≠ \`proxy\` |
| \`https://example.com/v1proxy\` | ✗ | 单段不拆分 |
| 非法 URL / 空串 / undefined | ✗ | try/catch 兜底 |

\`\`\`bash
# 方式 1：URL 约定自动激活（推荐）
export ANTHROPIC_BASE_URL="http://your-proxy/api/v1/proxy/anthropic"
claude

# 方式 2：显式参数
export ANTHROPIC_BASE_URL="http://your-proxy/custom/path"
claude --force-oauth
\`\`\`

## 代码关键路径

### 1. 触发探测（src/main.tsx + src/utils/managedEnv.ts）

\`\`\`
main() 早期:
  argv 含 --force-oauth  ──┐
  BASE_URL 含 /v1/proxy  ──┤→ CLAUDE_FORCE_OAUTH=1 + 清理 API Key env
                           │
applySafe / applyConfig 入口:
  settings.json merge 后   │
  BASE_URL 含 /v1/proxy  ──┘→ 兜底探测（main.tsx 看不到 settings.json 的 BASE_URL）
\`\`\`

两层探测保证 BASE_URL 无论来自 shell 还是 settings.json，都能自动激活 force-oauth。

### 2. 认证路径选择（src/services/api/client.ts）

\`\`\`ts
const isThirdPartyProvider =
  getAPIProvider() === 'thirdParty' && !process.env.CLAUDE_FORCE_OAUTH
const effectiveSubscriber = isClaudeAISubscriber() && !isThirdPartyProvider
\`\`\`

- 正常模式：BASE_URL 非 Anthropic 域 → \`isThirdPartyProvider=true\` → API Key 路径
- force-oauth 模式：绕过检查 → \`effectiveSubscriber=true\` → OAuth Bearer 路径

force-oauth 诊断日志会打印 \`effectiveSubscriber / tokenPrefix / expiresAt / isExpired / BASE_URL\`，
\`ANTHROPIC_LOG=debug\` 开启后搜 \`[force-oauth]\` 即可看到。

### 3. 客户端构造（src/services/api/client.ts）

\`\`\`ts
const customBaseUrl = process.env.ANTHROPIC_BASE_URL  // 代理 URL（保留不动）
const resolvedAuthToken = isSubscriber
  ? getClaudeAIOAuthTokens()?.accessToken  // OAuth Bearer
  : undefined

const clientConfig = {
  authToken: resolvedAuthToken,
  ...(customBaseUrl ? { baseURL: customBaseUrl } : {}),
}
\`\`\`

请求会带上 OAuth Bearer token，发往 \`ANTHROPIC_BASE_URL\` 指定的代理。
SDK 会同时发送 \`Authorization: Bearer <token>\` 头。

### 4. OAuth 控制面统一走代理（src/constants/oauth.ts）

\`\`\`ts
// 当 ANTHROPIC_BASE_URL 存在时，将 OAuth 端点路径拼接到代理 URL 上
const getProxyUrl = (defaultUrl: string): string => {
  const baseUrl = process.env.ANTHROPIC_BASE_URL
  if (!baseUrl) return defaultUrl
  const cleanBaseUrl = baseUrl.replace(/\\\/$/, '')
  const url = new URL(defaultUrl)
  return \\\`\\\${cleanBaseUrl}\\\${url.pathname}\\\${url.search}\\\`
}
\`\`\`

所有 OAuth 端点（authorize/token/roles/profile/API key creation）统一通过
\`ANTHROPIC_BASE_URL\` 代理转发，不再区分控制面和数据面。

**URL 转换示例**（BASE_URL = \`http://proxy/api/v1/proxy/anthropic\`）：

| 原始 Anthropic URL | 代理后 URL |
|---|---|
| \`https://claude.com/cai/oauth/authorize\` | \`http://proxy/api/v1/proxy/anthropic/cai/oauth/authorize\` |
| \`https://platform.claude.com/v1/oauth/token\` | \`http://proxy/api/v1/proxy/anthropic/v1/oauth/token\` |
| \`https://api.anthropic.com/api/oauth/claude_cli/roles\` | \`http://proxy/api/v1/proxy/anthropic/api/oauth/claude_cli/roles\` |
| \`https://api.anthropic.com/v1/messages\` | \`http://proxy/api/v1/proxy/anthropic/v1/messages\` |

\`OAUTH_PROXY_*\` 环境变量仍可逐端点覆盖（优先级最高）。

### 5. Provider 判定（src/utils/model/providers.ts）

\`\`\`ts
function getAPIProvider(): 'firstParty' | 'thirdParty' | ... {
  if (process.env.ANTHROPIC_BASE_URL && !isFirstPartyAnthropicBaseUrl()) {
    return 'thirdParty'  // 代理 URL 会命中此分支
  }
}
\`\`\`

代理 URL 始终被判定为 \`thirdParty\`。force-oauth 通过 client.ts 层面绕过了
这个判定对认证路径的影响。

注意：这里说的是 provider / 认证路径判定，不等于系统提示词一定走 third-party 极简分支。
当前仓库中，Codex 场景复用完整的 Claude OAuth 风格提示词；OAuth 代理场景是否走极简提示词，仍以 prompts.ts 中的 prompt 路由条件为准。

### 6. HTTP 头管理（src/utils/http.ts）

\`getAuthHeaders()\` 动态检查 \`getAPIProvider() === 'thirdParty'\` 来决定
是否跳过 OAuth beta 头。force-oauth 模式下仍然认为是 thirdParty，因此
\`OAUTH_BETA_HEADER\` 不会被发送——避免代理 / 官方 API 因不认识的 beta
头而拒绝请求。

## 代理兼容性要求

**必须支持**：
- \`POST /v1/messages\`（API 消息调用）
- \`POST /v1/oauth/token\`（token 交换和刷新）
- \`GET /cai/oauth/authorize\` 或 \`GET /oauth/authorize\`（OAuth 授权页面代理/转发）
- **透传** \`Authorization: Bearer xxx\` 头（不能用代理自己的 token 库校验）

**可选**（完整支持需要）：
- \`GET /api/oauth/claude_cli/roles\`（角色查询）
- \`GET /api/oauth/profile\`（用户信息）
- \`POST /api/oauth/claude_cli/create_api_key\`（API key 创建）
- \`POST /v1/organizations/*/members/*/usage\`（用量查询）

## 与其他功能的交互

| 功能 | 交互 |
|------|------|
| \`--force-oauth\` | URL 含 \`/v1/proxy\` 时**自动等价**，无需显式传 |
| backup-api-fallback | force-oauth 下被禁用（\`switchToBackupApiConfig\` 直接 return false） |
| \`--bare\` | 与 force-oauth **互斥**。bare 要求 API Key，force-oauth 禁用 API Key |
| \`ANTHROPIC_MODEL\` | 被保留。代理应支持转发模型名到 Anthropic |
| \`isClaudeAISubscriber()\` | 必须为 \`true\`——用户需要有有效的 OAuth 订阅 |
| \`CLAUDE_API_MODE\` | URL 触发 force-oauth 时会清理 API_MODE（force-oauth 优先） |
| \`OAUTH_PROXY_*\` 环境变量 | 逐端点覆盖代理 URL，优先级最高 |

## 常见错误

| 错误 | 原因 | 解决 |
|------|------|------|
| 403 "Request not allowed" | OAuth Bearer 未附加（旧版代码 bug，已修复） | 确认使用最新源码 |
| 403 on /login | OAuth 授权 URL 未走代理或被篡改 | 确认 oauth/client.ts 无 .replace() 残留测试代码 |
| 401 "Invalid Token" | OAuth token 过期 | \`/login\` 刷新后重试 |
| 401 + \`rix_api_error\` | 代理有自己的 token 验证，不支持 OAuth Bearer 透传 | 需要在代理侧配置放行 |
| 529 "overloaded" | 代理或后端过载 | 正常重试 |

## 排查建议

1. \`ANTHROPIC_LOG=debug bun run dev\`：搜 \`[force-oauth]\` 查看 effectiveSubscriber/tokenPrefix/isExpired
2. 确认 \`echo $ANTHROPIC_BASE_URL\` 是代理地址（不是空或 api.anthropic.com）
3. URL 含 \`/v1/proxy\` 时无需额外传参，\`echo $CLAUDE_FORCE_OAUTH\` 应自动为 \`1\`
4. 用 curl 验证代理是否接受 Bearer token：
   \`\`\`bash
   curl -X POST http://your-proxy/api/v1/proxy/anthropic/v1/messages \\
     -H "Authorization: Bearer YOUR_OAUTH_TOKEN" \\
     -H "Content-Type: application/json" \\
     -d '{"model":"claude-opus-4-6","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}'
   \`\`\`
5. 若 401 \`rix_api_error\`：代理自身认证层拦截了 Bearer。代理需配置为透传 Authorization 头
6. 验证 OAuth 端点代理：
   \`\`\`bash
   curl http://your-proxy/api/v1/proxy/anthropic/v1/oauth/token \\
     -X POST -H "Content-Type: application/x-www-form-urlencoded" \\
     -d "grant_type=authorization_code&code=test"
   # 应返回 Anthropic OAuth 错误（非 502/404），说明代理转发正常
   \`\`\`
`

export function registerOauthProxySkill(): void {
  registerBundledSkill({
    name: 'oauth-proxy',
    description:
      '说明 OAuth 代理架构：通过 ANTHROPIC_BASE_URL 配置代理转发 Anthropic API 请求，配合 --force-oauth 使用 OAuth Bearer token 而非 API Key。包含代理兼容性要求、认证路径选择、常见错误排查。',
    userInvocable: true,
    async getPromptForCommand(args) {
      let prompt = OAUTH_PROXY_PROMPT
      if (args) {
        prompt += `\n\n## User Request\n\n${args}`
      }
      return [{ type: 'text', text: prompt }]
    },
  })
}
