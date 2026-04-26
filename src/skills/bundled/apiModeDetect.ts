import { registerBundledSkill } from '../bundledSkills.js'

const API_MODE_DETECT_PROMPT = `# API Mode Auto-Detection

本项目支持 **force-oauth** 和 **API Mode** 两种互为镜像的认证模式自动切换。
两者通过 \`process.env\` 标记互斥：

| 标记 | 触发条件 | 语义 |
|------|----------|------|
| \`CLAUDE_FORCE_OAUTH=1\` | \`--force-oauth\` 参数 / \`ANTHROPIC_BASE_URL\` 含 \`/v1/proxy\` | 禁用 API Key，强制 OAuth Bearer |
| \`CLAUDE_API_MODE=1\` | shell 有 \`ANTHROPIC_API_KEY\` 且非 force-oauth | 禁用 settings.json OAuth 代理 BASE_URL，强制 API Key |

两者 **不能同时为 \`1\`**。当 URL 含 \`/v1/proxy\` 触发 force-oauth 时，
已有的 \`CLAUDE_API_MODE\` 会被自动清理。

## 触发与优先级

\`\`\`
main() 早期决策树：
  ↓
  argv 含 --force-oauth 或 BASE_URL 含 /v1/proxy?
  ├── 是 → CLAUDE_FORCE_OAUTH=1, 清理 API Key env
  │        → 不设置 CLAUDE_API_MODE（互斥）
  └── 否 → shell 有 ANTHROPIC_API_KEY?
           ├── 是 → CLAUDE_API_MODE=1
           │        → 保存 shell BASE_URL 到 _CLAUDE_API_MODE_BASE_URL
           └── 否 → 普通模式
\`\`\`

settings.json merge 后兜底（managedEnv.ts applySafe / applyConfig 入口）：
\`\`\`
BASE_URL 刚从 settings.json 注入，含 /v1/proxy?
├── 是 → CLAUDE_FORCE_OAUTH=1, 清理 CLAUDE_API_MODE 副作用
└── 否 → 原有标记不变
\`\`\`

## CLAUDE_API_MODE 行为

当 shell 环境提供了 \`ANTHROPIC_API_KEY\`（典型场景：用户配了 MiniMax API Key），
代码需要防止 \`settings.json\` 中配置的 OAuth 代理 \`ANTHROPIC_BASE_URL\` 覆盖
shell 环境。

**main.tsx 入口**（line 635-639）：
\`\`\`ts
if (!process.env.CLAUDE_FORCE_OAUTH && process.env.ANTHROPIC_API_KEY) {
  process.env.CLAUDE_API_MODE = '1'
  process.env._CLAUDE_API_MODE_BASE_URL = process.env.ANTHROPIC_BASE_URL || ''
}
\`\`\`

**managedEnv.ts applySafe 末尾**（settings merge 后）：
\`\`\`ts
if (process.env.CLAUDE_API_MODE) {
  const shellBaseUrl = process.env._CLAUDE_API_MODE_BASE_URL
  if (shellBaseUrl) {
    process.env.ANTHROPIC_BASE_URL = shellBaseUrl  // 恢复 shell 原始值
  } else {
    delete process.env.ANTHROPIC_BASE_URL  // settings 注入的被清除
  }
}
\`\`\`

效果：settings.json 的 \`ANTHROPIC_BASE_URL\` 被 shell 原始值覆盖或清除，
用户的 API Key 路径不受 settings 中的 OAuth 代理干扰。

## force-oauth 对 API_MODE 的抢占

当 managedEnv.ts 入口探测到 BASE_URL 含 \`/v1/proxy\` 时：
\`\`\`ts
if (!process.env.CLAUDE_FORCE_OAUTH &&
    (process.env.ANTHROPIC_BASE_URL || '').includes('/v1/proxy')) {
  process.env.CLAUDE_FORCE_OAUTH = '1'
  delete process.env.CLAUDE_API_MODE           // ← 清理
  delete process.env._CLAUDE_API_MODE_BASE_URL // ← 清理
}
\`\`\`

场景：shell 有 \`ANTHROPIC_API_KEY\`，main() 先设了 \`CLAUDE_API_MODE=1\`；
settings.json 注入的 \`ANTHROPIC_BASE_URL\` 含 \`/v1/proxy\` → applySafe 入口
探测命中 → force-oauth 抢占 → API_MODE 被清理。

这样保证了 **URL 约定优先**：代理 URL 声明了 OAuth 代理身份，优先级高于
shell API Key。

## 关键代码位置

| 文件 | 位置 | 作用 |
|------|------|------|
| \`src/main.tsx\` line 635-639 | main() 早期 | 触发 API_MODE, 保存 shell BASE_URL |
| \`src/utils/managedEnv.ts\` applySafe 末尾 | settings merge 后 | 恢复 shell BASE_URL 或清除 settings 注入的 |
| \`src/utils/managedEnv.ts\` applySafe/apply 入口 | settings merge 后 | /v1/proxy 探测抢占 API_MODE |

## 与 force-oauth 的关系

| | force-oauth | API Mode |
|---|---|---|
| 方向 | 从第三方 API 切回 OAuth | 从 OAuth 代理切到直连 API |
| 触发 | \`--force-oauth\` / BASE_URL 含 \`/v1/proxy\` | shell 有 \`ANTHROPIC_API_KEY\` |
| 效果 | 剥离 API Key，保留 BASE_URL | 保留 API Key，恢复 shell BASE_URL |
| 优先级 | **高**（URL 探测抢占 API_MODE） | 低 |

## 常见问题

- **问**：shell 同时有 \`ANTHROPIC_API_KEY\` 和 \`ANTHROPIC_BASE_URL\` 含 \`/v1/proxy\`？
  **答**：\`main.tsx\` 先检测 \`--force-oauth\` / URL → CLAUDE_FORCE_OAUTH=1 + 删除
  \`ANTHROPIC_API_KEY\`。API_MODE 不会被设置（因为 \`!process.env.CLAUDE_FORCE_OAUTH\`
  条件不满足）。force-oauth 永远优先。

- **问**：settings.json 有 \`ANTHROPIC_BASE_URL\` 含 \`/v1/proxy\`，shell 有 \`ANTHROPIC_API_KEY\`？
  **答**：main() 先设 API_MODE=1（此时看不到 settings 的 BASE_URL）。applySafe merge
  settings 后，入口探测命中 /v1/proxy → 抢占 API_MODE → force-oauth 模式。

- **问**：如何确认当前是哪种模式？
  **答**：\`ANTHROPIC_LOG=debug\` 启动，搜索日志中的 \`[force-oauth]\` 行（表示
  force-oauth 模式）。如果没有，检查 \`echo $CLAUDE_API_MODE\`。
`

export function registerApiModeDetectSkill(): void {
  registerBundledSkill({
    name: 'api-mode-detect',
    description:
      '说明 CLAUDE_API_MODE 与 CLAUDE_FORCE_OAUTH 两种互为镜像的认证模式自动切换机制：shell 有 API Key → API Mode；BASE_URL 含 /v1/proxy → force-oauth。force-oauth 优先级更高，URL 探测会抢占 API_MODE。',
    userInvocable: true,
    async getPromptForCommand(args) {
      let prompt = API_MODE_DETECT_PROMPT
      if (args) {
        prompt += `\n\n## User Request\n\n${args}`
      }
      return [{ type: 'text', text: prompt }]
    },
  })
}
