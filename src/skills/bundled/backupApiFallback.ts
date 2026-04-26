import { registerBundledSkill } from '../bundledSkills.js'

const BACKUP_API_FALLBACK_PROMPT = `# Backup API Fallback on Rate Limit

本项目内置 **OAuth 套餐用量超限自动切换备用 API** 的能力。当 Claude 官方
OAuth 订阅（Max / Pro）触发 429 配额限制（典型错误消息：
\`You've hit your limit · resets 3am (Asia/Shanghai)\`）时，会自动切换到
\`~/.claude/settings.json\`（若环境变量 \`ANTHROPIC_BASE_URL\` 包含 \`/v1/proxy\`，
则改用 \`~/.claude/settings_new.json\`）中配置的备用 API credentials，继续完成当前请求和
后续会话，而不是把错误直接抛给用户。

## 配置方式

在活动用户配置文件（默认 \`~/.claude/settings.json\`；若环境变量
\`ANTHROPIC_BASE_URL\` 包含 \`/v1/proxy\`，则 \`~/.claude/settings_new.json\`）
的 \`env\` 字段中添加两项：

\`\`\`json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN_BAK": "备用API的token",
    "ANTHROPIC_BASE_URL_BAK": "https://备用API/anthropic"
  }
}
\`\`\`

- \`ANTHROPIC_AUTH_TOKEN_BAK\` — 备用 API 的认证 token
- \`ANTHROPIC_BASE_URL_BAK\` — 备用 API 的 base URL（Anthropic 兼容端点，如 MiniMax）

这两个变量会在启动时由 \`managedEnv.ts\` 自动注入到 \`process.env\`，无需额外读取
settings.json。

## 触发条件与行为

切换动作在 \`withRetry\` 的 catch 块中执行，**所有下列条件必须同时满足**：

1. 错误是 \`APIError\` 且 \`status === 429\`
2. 当前用户是 Claude OAuth 订阅用户（\`isClaudeAISubscriber() === true\`）
3. 备用配置存在（\`hasBackupApiConfig() === true\`）
4. 尚未切换过（\`isBackupApiActivated() === false\`，防止重复切换）

一旦满足，\`switchToBackupApiConfig()\` 会执行：

1. \`process.env.ANTHROPIC_BASE_URL = ANTHROPIC_BASE_URL_BAK\`
2. \`process.env.ANTHROPIC_AUTH_TOKEN = ANTHROPIC_AUTH_TOKEN_BAK\`
3. \`process.env.ANTHROPIC_API_KEY = ANTHROPIC_AUTH_TOKEN_BAK\`（同步设置以
   满足 SDK 构造器，并确保 \`isAnthropicAuthEnabled()\` 落到 line 103 的快速
   判定返回 false）
4. 设置模块级标志 \`_backupActivated = true\`
5. 把 \`withRetry\` 循环中的 \`client\` 置为 \`null\`，强制下一次迭代重建客户端
6. \`continue\` 进入重试（跳过 \`shouldRetry()\` 检查）

切换后，\`isClaudeAISubscriber()\` 会返回 \`false\`，因此后续任何 429 错误都会
走正常的 \`shouldRetry()\` 重试路径（而非订阅用户的立即失败路径），整个会话
会持续使用备用 API，直到进程退出。

## 关键代码位置

| 文件 | 作用 |
|------|------|
| \`src/utils/backupApiConfig.ts\` | 新建：\`hasBackupApiConfig\` / \`isBackupApiActivated\` / \`switchToBackupApiConfig\` |
| \`src/services/api/withRetry.ts\` (catch 块 \`shouldRetry\` 前) | 新增拦截：命中条件 → 切换 + \`client = null\` + \`continue\` |
| \`src/utils/managedEnv.ts\` \`applySafeConfigEnvironmentVariables\` | 复用：把 settings.json \`env\` 注入 \`process.env\`，无需修改 |
| \`src/utils/auth.ts\` \`isAnthropicAuthEnabled\` line 103 | 复用：\`ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY\` 同时存在时返回 false |
| \`src/services/api/client.ts\` \`configureApiKeyHeaders\` | 复用：非订阅用户路径自动把 \`ANTHROPIC_AUTH_TOKEN\` 设为 \`Authorization: Bearer\` 头 |

## 设计要点（为什么这样实现）

- **为什么在 \`withRetry\` catch 块？**
  这是 429 错误的唯一汇聚点。\`shouldRetry()\` 对订阅用户的 429 返回 \`false\`，
  拦截必须放在 \`shouldRetry()\` 调用前，否则错误会立刻抛成 \`CannotRetryError\`。

- **为什么同时设置三个 env 变量？**
  - \`ANTHROPIC_BASE_URL\`：被 \`getAnthropicClient\` 读作 \`baseURL\`
  - \`ANTHROPIC_AUTH_TOKEN\`：被 \`configureApiKeyHeaders\` 读作 Bearer token
  - \`ANTHROPIC_API_KEY\`：让 SDK 构造器有合法的 apiKey 字段，并触发
    \`isAnthropicAuthEnabled()\` line 103 的双变量快速判定

- **为什么不弹 UI 提示？**
  切换成功后 \`continue\` 直接重试，错误对象不会再传到 \`queryModel\` catch 块，
  也就不会生成 assistant 错误消息——用户看到的只是请求"成功返回"，对体验最友好。
  若需要日志取证，\`switchToBackupApiConfig\` 已通过 \`logForDebugging\` 打点。

- **为什么用模块级 \`_backupActivated\` 标志？**
  防止同一进程内重复切换。首次切换后 \`isClaudeAISubscriber()\` 就会返回
  \`false\`，再次 429 时第 2 个拦截条件天然为 \`false\`，标志其实是冗余保险——
  保留它让语义更清晰、也便于单测。

## 常见问题

- **问**：备用 API 也超限了怎么办？
  **答**：由于切换后 \`isClaudeAISubscriber()\` 是 \`false\`，后续 429 会走
  \`shouldRetry()\` 的常规重试（默认指数退避），耗尽重试次数后正常显示错误。

- **问**：能不能在当前会话中途切回官方 OAuth？
  **答**：当前实现不支持会话内回切（刻意设计为单向）。如需回切，重启 CLI 即可。

- **问**：和 \`--force-oauth\` 是什么关系？
  **答**：\`--force-oauth\` 禁用 API Key 认证路径（包括备用 API Key），强制走 OAuth
  Bearer token。它会剥离 \`ANTHROPIC_AUTH_TOKEN_BAK\` / \`ANTHROPIC_BASE_URL_BAK\`，
  同时 \`switchToBackupApiConfig()\` 内部也会检查 \`CLAUDE_FORCE_OAUTH\` 并 return false。
  因此 force-oauth 模式下备用 API 回落永远不会触发——这是刻意设计。
  **注意**：当 \`ANTHROPIC_BASE_URL\` 路径含 \`"/v1/proxy"\` 时会自动激活 force-oauth，
  等价于手动传 \`--force-oauth\`。此时备用 API 回落同样不会触发。
  如果严格不想触发回落，不要配置 \`*_BAK\` 变量或使用 \`--force-oauth\` 或设置含
  \`/v1/proxy\` 的 BASE_URL。

- **问**：settings.json 里的 \`*_BAK\` 变量会不会被过滤掉？
  **答**：不会。\`managedEnv.ts\` 的 \`filterSettingsEnv\` 只剥离 SSH 隧道相关变量
  和 host-managed provider 变量，\`*_BAK\` 不在任何黑名单中。\`userSettings\` 是
  受信源，所有 env 会原样注入 \`process.env\`。

## 排查建议

如果配置了备用但没自动切换：
1. 检查活动用户配置文件的 \`env\` 字段里两个 \`*_BAK\` 变量都在
2. \`claude --debug\` 启动，观察日志是否有 \`[backupApi] Activated backup API\`
3. 确认错误确实是 429（不是 401/403/529）
4. 确认当前是 OAuth 订阅用户：\`isClaudeAISubscriber()\` 为 \`true\`——如果你本
   来就在用第三方 API，这个功能不会触发（也不需要触发，\`shouldRetry\` 本身就
   会重试 429）
`

export function registerBackupApiFallbackSkill(): void {
  registerBundledSkill({
    name: 'backup-api-fallback',
    description:
      '说明并配置 OAuth 套餐用量超限(429)时自动切换到备用 API 的能力：在活动用户配置文件中配置 ANTHROPIC_AUTH_TOKEN_BAK 和 ANTHROPIC_BASE_URL_BAK（默认 ~/.claude/settings.json；若环境变量 ANTHROPIC_BASE_URL 包含 /v1/proxy，则 ~/.claude/settings_new.json），命中 "You\'ve hit your limit" 时 withRetry 会自动切换到备用 credentials 并重试，整个会话持续使用备用 API 直到进程退出。',
    userInvocable: true,
    async getPromptForCommand(args) {
      let prompt = BACKUP_API_FALLBACK_PROMPT
      if (args) {
        prompt += `\n\n## User Request\n\n${args}`
      }
      return [{ type: 'text', text: prompt }]
    },
  })
}
