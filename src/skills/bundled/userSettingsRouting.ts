import { registerBundledSkill } from '../bundledSkills.js'

const USER_SETTINGS_ROUTING_PROMPT = `# User Settings 文件路径路由

本项目对用户级 settings（\`~/.claude/\` 下的配置文件）做了**条件化路径选择**，
用来把 OAuth 代理模式的用户数据与官方 API 模式的用户数据物理隔离——同一台
机器可以同时保留两套干净的 settings。

## 路径决策（由 \`getUserSettingsFilename()\` 统一裁决）

\`\`\`
shouldUseProxyUserSettingsFile() =
  ① isOauthProxyBaseUrl()            // 快路径: env 已显式指向代理 URL
  ② hasProxyUserSettingsFileOnDisk() // 兜底: ~/.claude/settings_new.json 存在
\`\`\`

优先级自顶向下：

| # | 条件 | 返回文件名 |
|---|------|------------|
| 1 | \`--cowork\` / \`CLAUDE_CODE_USE_COWORK_PLUGINS=1\` | \`cowork_settings.json\` |
| 2 | \`ANTHROPIC_BASE_URL\` 的 pathname 含相邻 \`v1\` + \`proxy\` 段 | \`settings_new.json\` |
| 3 | \`~/.claude/settings_new.json\` 在磁盘上实际存在 | \`settings_new.json\` |
| 4 | 默认 | \`settings.json\` |

## 为什么需要第 3 条（磁盘兜底）——引导悖论

**场景**：用户把 OAuth 代理配置只写在 \`~/.claude/settings_new.json\` 里：

\`\`\`json
{
  "env": { "ANTHROPIC_BASE_URL": "https://proxy.example.com/v1/proxy/anthropic" }
}
\`\`\`

shell 里没有 \`ANTHROPIC_BASE_URL\`。没有第 3 条时的执行链：

\`\`\`
1. getUserSettingsFilename() 被调用（读 settings 的必经之路）
2. isOauthProxyBaseUrl() 返回 false（env 没 BASE_URL）
3. → 返回 'settings.json'
4. 读 settings.json（可能为空 / 无 BASE_URL）
5. applySafeConfigEnvironmentVariables() 从 settings.json 注入 env → 没 BASE_URL
6. force-oauth 永远不会被触发
7. settings_new.json 从头到尾没被碰过 ← 鸡生蛋问题
\`\`\`

第 3 条用 \`statSync\` 一次磁盘探测打破此环：\`settings_new.json\` 只要存在就优先
读它；读完后 \`env\` 注入生效，下游的 URL 触发器（\`main.tsx\` / \`managedEnv.ts\`）
自然拿到代理 URL → force-oauth 正常激活。

## 关键代码位置

| 模块 | 位置 | 作用 |
|------|------|------|
| \`src/utils/settings/settings.ts\` | \`shouldUseProxyUserSettingsFile()\` | 二级决策：env 快路径 + 磁盘兜底 |
| \`src/utils/settings/settings.ts\` | \`hasProxyUserSettingsFileOnDisk()\` | \`statSync\` 探测，进程级缓存 |
| \`src/utils/settings/settings.ts\` | \`getUserSettingsFilename()\` | cowork → proxy → default 三级 |
| \`src/utils/settings/settings.ts\` | \`getSettingsFilePathForSource('userSettings')\` | 组装绝对路径 |
| \`src/utils/model/providers.ts\` | \`isOauthProxyBaseUrl()\` | URL 路径段精确匹配（v1 + proxy） |
| \`src/services/settingsSync/types.ts\` | \`getActiveUserSettingsSyncKey()\` | sync 上传 key 随路由同步切换 |
| \`src/services/settingsSync/types.ts\` | \`getCompatibleUserSettingsSyncKeys()\` | sync 下载时兼容读旧 key |

## 进程级缓存

\`proxyFileOnDiskCache\` 是 module-local 的 \`boolean | null\`：

- 避免每次 \`getUserSettingsFilename()\` 都走 \`statSync\`（启动路径调用频繁）
- 文件的"无 → 有 / 有 → 无"迁移是非常规运维动作，进程内 staleness 可接受
- 测试钩子 \`_resetProxyFileOnDiskCacheForTesting()\` 允许 flip 文件状态后重探测
- 若将来需要热响应磁盘变化，可在 \`resetSettingsCache()\` 中追加清理逻辑

## 互操作性

| 功能 | 交互 |
|------|------|
| \`--cowork\` | 优先级最高，直接覆盖 proxy / default |
| force-oauth (URL 触发) | 只要 \`isOauthProxyBaseUrl()\` 命中，自动走 \`settings_new.json\` |
| force-oauth (显式参数) | 不改路径，继续用 \`settings.json\`（除非 BASE_URL 也是代理） |
| backup-api-fallback | 无关 — 路径路由发生在 settings 读取层 |
| \`CLAUDE_API_MODE\`（第三方 API） | BASE_URL 不含 \`v1/proxy\` → 继续用 \`settings.json\` |
| settings sync（上传 / 下载） | 用 \`getActiveUserSettingsSyncKey()\` 跟路由联动；下载兼容两个 key |

## 远端 Sync key 双读

\`\`\`ts
getCompatibleUserSettingsSyncKeys() = [
  primary,    // 当前路由命中的 key
  secondary,  // 另一把
]
applyRemoteEntriesToLocal:
  .map(key => entries[key]).find(Boolean)  // 取第一个非空
\`\`\`

primary 优先。避免已有 \`~/.claude/settings.json\` 的远端数据因切路径而失效。

## 常见问题

**Q: 已有 \`settings.json\` 想迁到 \`settings_new.json\`？**

\`\`\`bash
cp ~/.claude/settings.json ~/.claude/settings_new.json
# 编辑 settings_new.json，在 env 下加入 ANTHROPIC_BASE_URL
\`\`\`

下一次启动磁盘兜底命中，自动读 \`settings_new.json\`；旧 \`settings.json\` 保持
原状作为官方 API 模式的 fallback。

**Q: 两个文件并存，冲突怎么办？**

只会读其中**一个**。决策顺序见上表；若 proxy 模式激活，\`settings.json\` 会被
完全忽略（不是 merge）。

**Q: 怎么回到官方 API 模式？**

两种方式任选：
1. \`unset ANTHROPIC_BASE_URL && mv ~/.claude/settings_new.json ~/.claude/settings_new.json.bak\`
2. 或保留 \`settings_new.json\`，用 shell env 显式 \`export ANTHROPIC_API_KEY=...\`
   （进入 API 模式，\`main.tsx\` 的 \`CLAUDE_API_MODE\` 分支会接管）

**Q: 验证当前用到哪个文件？**

\`\`\`bash
bun -e "import { getSettingsFilePathForSource } from './src/utils/settings/settings.ts'; \\
  console.log(getSettingsFilePathForSource('userSettings'))"
\`\`\`

## 排查建议

1. 确认磁盘状态：\`ls -la ~/.claude/settings*.json\`
2. 确认 env：\`echo \$ANTHROPIC_BASE_URL\`
3. 确认决策：运行上方的 \`getSettingsFilePathForSource\` 一行脚本
4. 若路由异常，检查 \`isOauthProxyBaseUrl()\` 是否按预期命中——URL 必须含相邻的
   \`v1\` + \`proxy\` 两段（\`proxy_old\` / \`proxyfoo\` 不会命中）
`

export function registerUserSettingsRoutingSkill(): void {
  registerBundledSkill({
    name: 'user-settings-routing',
    description:
      '说明 user settings 文件路径路由：cowork/OAuth 代理/默认三级决策、settings_new.json 磁盘兜底（解决引导悖论）、isOauthProxyBaseUrl 的路径段精确匹配、settings sync 兼容双 key 读取。',
    userInvocable: true,
    async getPromptForCommand(args) {
      let prompt = USER_SETTINGS_ROUTING_PROMPT
      if (args) {
        prompt += `\n\n## User Request\n\n${args}`
      }
      return [{ type: 'text', text: prompt }]
    },
  })
}
