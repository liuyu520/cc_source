import { registerBundledSkill } from '../bundledSkills.js'

const FORCE_OAUTH_PROMPT = `# Force OAuth Login Mode

本项目已内置 \`--force-oauth\` / \`--force_oauth\` 启动参数。

**核心语义**：禁用 API Key 认证路径，强制使用 OAuth Bearer token 进行认证，
同时 **保留** 用户配置的 \`ANTHROPIC_BASE_URL\`（优先级最高）——OAuth Bearer
会通过该 BASE_URL 指定的代理转发到官方 Anthropic API。

适用场景：用户本地已登录 OAuth 账号，同时通过 \`ANTHROPIC_BASE_URL\` 配置了
一个支持 OAuth 转发的代理（例如 \`http://your-proxy/api/v1/proxy/anthropic\`），
希望让 OAuth Bearer 走代理而非直连 \`api.anthropic.com\`。

## 触发条件（任一命中即进入 force-oauth 模式）

1. **CLI 参数**：\`--force-oauth\` / \`--force_oauth\`
2. **环境变量**：\`export CLAUDE_FORCE_OAUTH=1\`
3. **URL 约定（隐式触发）**：\`ANTHROPIC_BASE_URL\` 路径里包含 \`"/v1/proxy"\`
   —— 这是 OAuth 代理的约定标识，shell env 或 settings.json 中配置都适用。
   无需显式加参数，代码会在 main.tsx 早期 / managedEnv 两个 apply 函数入口自动识别。

\`\`\`bash
# 方式 1：CLI 参数
claude --force-oauth
claude --dangerously-skip-permissions --force_oauth

# 方式 2：环境变量
export CLAUDE_FORCE_OAUTH=1 && claude

# 方式 3：URL 约定（自动激活，无需其他动作）
export ANTHROPIC_BASE_URL="http://your-proxy/api/v1/proxy/anthropic"
claude
\`\`\`

三种写法等价，都会设置 \`process.env.CLAUDE_FORCE_OAUTH='1'\` 作为生命周期标记，
下游所有 \`CLAUDE_FORCE_OAUTH\` 判断点（client.ts / oauth.ts / managedEnv.ts /
backupApiConfig.ts）自动复用同一条通路。

## 被剥离的变量

| 变量 | 原因 |
|------|------|
| \`ANTHROPIC_API_KEY\` | 禁用 API Key 认证路径 |
| \`ANTHROPIC_AUTH_TOKEN\` | 禁用 API Key 认证路径 |
| \`ANTHROPIC_AUTH_TOKEN_BAK\` | 禁用备用 API Key 回落 |
| \`ANTHROPIC_BASE_URL_BAK\` | 禁用备用 API 回落 |
| \`CLAUDE_CODE_USE_BEDROCK\` | 云 provider 与 OAuth 互斥 |
| \`CLAUDE_CODE_USE_VERTEX\` | 云 provider 与 OAuth 互斥 |
| \`CLAUDE_CODE_USE_FOUNDRY\` | 云 provider 与 OAuth 互斥 |

## 被保留的变量

| 变量 | 原因 |
|------|------|
| \`ANTHROPIC_BASE_URL\` | **优先级最高**，用户的 OAuth 代理地址 |
| \`ANTHROPIC_MODEL\` | 模型名（如 \`claude-opus-4-6\`） |
| \`ANTHROPIC_DEFAULT_HAIKU_MODEL\` | 模型映射 |
| \`ANTHROPIC_DEFAULT_OPUS_MODEL\` | 模型映射 |
| \`ANTHROPIC_DEFAULT_SONNET_MODEL\` | 模型映射 |

## 六层防御架构

### 第一层：早期 argv / URL 探测（src/main.tsx main() 入口）
在任何 env / config 读取之前，命中下列任一条件即激活 force-oauth：
- \`process.argv\` 含 \`--force-oauth\` / \`--force_oauth\`
- \`process.env.ANTHROPIC_BASE_URL\` 路径含 \`"/v1/proxy"\`（shell env 场景）

激活后：
1. 设置 \`process.env.CLAUDE_FORCE_OAUTH='1'\` 作为生命周期标记
2. 删除会触发 API Key 认证路径的变量（\`ANTHROPIC_API_KEY\` / \`ANTHROPIC_AUTH_TOKEN\` 等）
3. **保留** \`ANTHROPIC_BASE_URL\` / \`ANTHROPIC_MODEL\` / \`ANTHROPIC_DEFAULT_*_MODEL\`

注：settings.json 提供的 BASE_URL 在 main() 早期尚未注入 process.env，
会被第三层的 applySafe / applyConfig 入口探测兜住。

### 第二层：源头过滤（src/utils/managedEnv.ts withoutForceOAuthVars）
复用 \`withoutSSHTunnelVars\` 的解构过滤模式，在 \`filterSettingsEnv\` 管道中
**从 settings env 对象中剥离 API Key 相关变量**，保证 settings.json 不会注入
\`ANTHROPIC_API_KEY\` / \`ANTHROPIC_AUTH_TOKEN\` 等。覆盖所有 env 注入路径：
- \`getGlobalConfig().env\`（~/.claude.json）
- \`getSettingsForSource('userSettings').env\`（默认 \`~/.claude/settings.json\`；若环境变量 \`ANTHROPIC_BASE_URL\` 包含 \`/v1/proxy\`，则 \`~/.claude/settings_new.json\`）
- \`getSettingsForSource('policySettings').env\`（远程策略）
- \`getSettings_DEPRECATED().env\`（合并后的全量配置）

### 第三层：事后守卫 + URL 兜底探测（applySafe / applyConfig）
在两个 env 应用函数里：
1. **入口处**：检测 \`process.env.ANTHROPIC_BASE_URL\` 是否含 \`"/v1/proxy"\`，
   命中则置 \`CLAUDE_FORCE_OAUTH=1\`（settings.json 此时刚 merge 到 process.env，
   main.tsx 早期探测不到，这里负责兜底）；同时清理 \`CLAUDE_API_MODE\` 副作用。
2. **末尾处**：再次 \`delete process.env.ANTHROPIC_API_KEY\` 等兜底，防止任何
   未经 \`filterSettingsEnv\` 管道的意外注入。

### 第四层：客户端认证路径改写（src/services/api/client.ts）
**这是真正修复 403 "Request not allowed" 的核心**。

原本 \`isThirdPartyProvider = getAPIProvider() === 'thirdParty'\` 在 BASE_URL 为
第三方域名时为 \`true\`，导致 \`effectiveSubscriber = false\`，OAuth Bearer 不会
附加到请求上，代理收到无 Authorization 头的请求 → 返回 403。

修改为：
\`\`\`ts
const isThirdPartyProvider =
  getAPIProvider() === 'thirdParty' && !process.env.CLAUDE_FORCE_OAUTH
\`\`\`

这样 force-oauth 下 \`effectiveSubscriber = true\`，OAuth Bearer 正常附加，
请求通过 \`ANTHROPIC_BASE_URL\` 代理转发到官方 API。

### 第五层：OAuth 配置统一走代理（src/constants/oauth.ts）
\`getProdOauthConfig()\` 函数化延迟求值（非模块级常量），每次调用都读取当前
\`process.env.ANTHROPIC_BASE_URL\`。\`getProxyUrl()\` 将 OAuth 端点 URL 的路径
拼接到代理 URL 上，使 authorize/token/roles/profile 等控制面端点和
/v1/messages 数据面统一走代理。

\`OAUTH_PROXY_*\` 环境变量可逐端点覆盖（优先级最高）。

### 第六层：备用 API 切换守卫（src/utils/backupApiConfig.ts）
\`switchToBackupApiConfig()\` 在 force-oauth 模式下直接 \`return false\`，
防止 429 限速触发备用 API Key 切换绕过 force-oauth。

## 关键代码位置

| 文件 | 作用 |
|------|------|
| \`src/main.tsx\` (main() 早期) | **触发点 1**：识别 \`--force_oauth\` argv 或 BASE_URL 含 \`/v1/proxy\` → 置 \`CLAUDE_FORCE_OAUTH\`，清理 API Key env |
| \`src/utils/managedEnv.ts\` 两个 apply 入口 | **触发点 2**：settings.json merge 后再次探测 BASE_URL \`/v1/proxy\`，兜住迟到注入场景 |
| \`src/services/api/client.ts\` \`isThirdPartyProvider\` | **核心修复**：force-oauth 下让 OAuth Bearer 附加到第三方 BASE_URL 请求 |
| \`src/services/api/client.ts\` force-oauth 诊断日志 | 打印 token 前缀/过期时间/BASE_URL，定位 401 问题 |
| \`src/utils/managedEnv.ts\` \`withoutForceOAuthVars\` | **源头过滤**：从 settings env 对象剥离 API Key 变量 |
| \`src/utils/managedEnv.ts\` 两个 apply 函数末尾 | **事后守卫**：兜底 delete API Key 变量 |
| \`src/constants/oauth.ts\` \`getProdOauthConfig()\` | **OAuth 控制面走代理**：getProxyUrl() 将 OAuth 端点路径拼接到 ANTHROPIC_BASE_URL，authorize/token/roles 等统一经代理转发 |
| \`src/utils/backupApiConfig.ts\` | **备用切换守卫**：force-oauth 下禁止切换到备用 API Key |

## 常见问题

- **问**：和 \`--bare\` 有何区别？
  **答**：\`--bare\` 严格要求 \`ANTHROPIC_API_KEY\` 或 apiKeyHelper，且禁用 OAuth/keychain；
  \`--force-oauth\` 正相反：禁用 API Key 强制走 OAuth，同时保留 BASE_URL 让 OAuth
  Bearer 通过代理转发。两者互斥。

- **问**：能否用环境变量等价触发？
  **答**：可以直接 \`export CLAUDE_FORCE_OAUTH=1\`。

- **问**：代理不支持 \`/v1/oauth/token\` 端点怎么办？
  **答**：OAuth 代理模式要求代理能转发所有 Anthropic 端点（authorize/token/roles/
  profile/messages）。如果代理不支持 OAuth 端点，可通过 \`OAUTH_PROXY_*\` 环境变量
  逐端点覆盖（如 \`OAUTH_PROXY_TOKEN_URL\` 指向 Anthropic 官方 URL）。

- **问**：报 401 "Invalid Token" / \`rix_api_error\` 怎么办？
  **答**：\`rix_api_error\` 是代理自身的认证层返回的，说明代理收到了 Bearer 但
  不认识。两种可能：
  (a) OAuth token 已过期 —— 执行 \`/login\` 重新认证即可。
  (b) 代理未配置 OAuth Bearer 透传 —— 代理必须把 \`Authorization: Bearer <token>\`
  原样转发到 \`api.anthropic.com\`，不能用自己的 rix 库校验。
  开启 \`ANTHROPIC_LOG=debug\`，日志里搜 \`[force-oauth]\` 行可看到
  \`tokenPrefix / expiresAt / isExpired / BASE_URL\` 做诊断。

- **问**：为什么修复前报 403 "Request not allowed"？
  **答**：因为 \`isThirdPartyProvider=true\` 导致 OAuth Bearer 不被附加，
  代理收到无 Authorization 头的请求 → 403。修复后 force-oauth 绕过了
  isThirdPartyProvider 检查，Bearer 正常附加。

## 排查建议

如果 force-oauth 后仍然报错：
1. 确认触发：\`echo $CLAUDE_FORCE_OAUTH\`（应为 \`1\`），或 BASE_URL 含 \`/v1/proxy\`
2. 使用最新源码：\`bun run dev -- --force-oauth\`，**不要**用旧的 \`bin/claude\` 二进制（不含源码改动）
3. 开启诊断日志：\`ANTHROPIC_LOG=debug bun run dev -- --force-oauth\`，日志中搜
   \`[force-oauth]\` 行查看 \`effectiveSubscriber / tokenPrefix / isExpired / BASE_URL\`
4. 看到 \`[API:request]\` 日志确认实际发出的 BASE_URL 和是否带 Authorization 头
5. 确认代理服务**透传** \`Authorization: Bearer\` 头到 \`api.anthropic.com\`
   （不能用代理自己的 rix/token 库二次校验）
6. 如 401 / \`rix_api_error\`：先不带 force-oauth 做 \`/login\` 刷新，再加回参数
`

export function registerForceOauthSkill(): void {
  registerBundledSkill({
    name: 'force-oauth',
    description:
      '说明 --force-oauth / --force_oauth 启动参数：禁用 API Key 认证，强制使用 OAuth Bearer token，同时保留 ANTHROPIC_BASE_URL（用户的 OAuth 代理地址）。OAuth Bearer 通过 BASE_URL 代理转发到官方 API。',
    userInvocable: true,
    async getPromptForCommand(args) {
      let prompt = FORCE_OAUTH_PROMPT
      if (args) {
        prompt += `\n\n## User Request\n\n${args}`
      }
      return [{ type: 'text', text: prompt }]
    },
  })
}
