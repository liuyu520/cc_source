import { registerBundledSkill } from '../bundledSkills.js'

const UI_THEME_PROMPT = `# UI Theme / 状态栏 & 组件配色复用

当用户要求修改 Ink/React 组件的文本或边框颜色（状态栏 pill、提示、对话框、日志等），
**必须复用 \`src/utils/theme.ts\` 的已有色位**，不得直接写 \`rgb(...)\` 或 \`#hex\`，
也不得随意新增 Theme 字段（除非用户明确要求）。

## 色板速查（\`src/utils/theme.ts\`）

| 主题名 | light 值 | 语义用法 |
|--------|---------|----------|
| \`claude\` | rgb(215,119,87) 橙 | provider / AI 品牌标识 |
| \`ide\` | rgb(71,130,200) 蓝 | IDE / 远程链接 / 源码控制（git branch） |
| \`permission\` | rgb(87,105,247) 中蓝 | 权限请求 |
| \`suggestion\` | rgb(87,105,247) 中蓝 | 建议 / 次级强调 |
| \`planMode\` | rgb(0,102,102) 青 teal | plan 模式、会话/任务标识 |
| \`success\` | rgb(44,122,57) 绿 | 成功 / 工作目录 / 通过校验 |
| \`error\` | rgb(171,43,63) 红 | 错误 / bypass 权限 / 第三方 provider brand |
| \`warning\` | rgb(150,108,30) 琥珀 | 警告 / 速率限制 |
| \`autoAccept\` | rgb(135,0,255) 紫 | acceptEdits 模式 |
| \`bashBorder\` | rgb(255,0,135) 粉 | bash 模式边框 |
| \`chromeYellow\` | rgb(251,188,4) 黄 | chrome 黄（辅助强调） |
| \`professionalBlue\` | rgb(106,155,204) 蓝 | grove 蓝 |
| \`subtle\` / \`inactive\` | 灰系 | 次要辅助文本（≈ dimColor） |
| \`fastMode\` | rgb(255,106,0) 橙红 | fast 模式 |

**禁用色名**：\`*_FOR_SUBAGENTS_ONLY\`、\`*_FOR_SYSTEM_SPINNER\`、\`*Shimmer\`、
\`diffAdded/Removed*\`、\`rainbow_*\`、\`_body / _background\` — 用途受限，
用在普通文本会破坏既定语义。

## 规则

1. **复用优先**：写 \`color="X"\` 前，先 \`Grep\` \`color="X"\` 确认已有使用场景，沿用其语义。
2. **\`dimColor\` 与 \`color=\` 互斥**：同时用会使彩色变暗。想要彩色必须去掉 \`dimColor\`。
3. **色系不要堆叠**：同一行 / 区域避免并列多个蓝或多个红；用不同色相建立层次。
4. **分隔符保持 dim**：pill 之间的 \`·\` \`|\` \`/\` 等分隔符保留 \`dimColor\`，让主体突出。
5. **动态色冲突检查**：\`getModeColor()\` 动态给出 \`error\`(bypass) / \`autoAccept\`(acceptEdits) /
   \`planMode\`(plan) / \`bashBorder\`(bash)；旁边静态 pill 不要用同色，否则视觉上被误读为同一语义。
6. **不新增 Theme 字段**：除非用户明确要求新色位，只在组件里引用已有字段。

## 标准语义映射

status bar / footer / 列表 pill 的典型分色（已在 \`PromptInputFooterLeftSide.tsx\` 应用）：

| pill 内容 | 推荐色 |
|----------|--------|
| provider / AI 品牌（\`em:API…\`） | \`claude\` |
| git 分支 / 源码控制（\`⎇git\\|cl: …\`） | \`ide\` |
| 会话 / 任务 ID（\`⎔ …\`） | \`planMode\` |
| 工作目录 / 路径基名 | \`success\` |
| 远程 / IDE 链接 | \`ide\` |
| 错误 / bypass 警示 | \`error\` |
| 警告 / rate limit | \`warning\` |

## 工作流

接到"把 X 改成 <色> / 给 X 上色 / 让 pill 分色区分"类需求：

1. **定位组件**：通常在 \`src/components/\` 下；用 Grep 找对应 \`<Text\` / \`<Box borderColor\`。
2. **选主题色**：对照上面"语义映射"挑，或 \`Grep\` \`color="X"\` 看已有使用场景是否贴合。
3. **检查冲突**：同行是否已有同色 pill；是否撞上 \`getModeColor\` 可能返回的动态色。
4. **改写**：把 \`dimColor\` 换成 \`color="<theme>"\`；同时想加粗时追加 \`bold\`。
5. **不改 theme.ts**：若能用现有色位表达就不要新增字段。
6. **分隔符保 dim**：若整行通过 \`renderFooterRow\` 统一插入分隔符，继续保留 \`dimColor\`。

## 反模式

- \`<Text color="rgb(0,0,255)">\` / \`<Text color="#00F">\` — 直接写 RGB/hex ❌
- \`<Text dimColor color="ide">\` — dimColor 压制颜色 ❌
- 给一行里所有 pill 都上色 — 没有主次 ❌
- 用 \`blue_FOR_SUBAGENTS_ONLY\` 等受限字段 ❌
- 为一次改色新增 Theme 字段 ❌

## 示例：状态栏 pill 分色

\`src/components/PromptInput/PromptInputFooterLeftSide.tsx\`：

\`\`\`tsx
const leadingParts = [
  ...(authIdentityLabel ? [<Text color="claude" key="auth-identity">
    {'em:' + authIdentityLabel.slice(0, 15)}
  </Text>] : []),
  ...(gitBranch ? [<Text color="ide" key="git-branch">
    {figures.arrowUp === '↑' ? '⎇git|cl: ' : ''}{gitBranch.slice(-15)}
  </Text>] : []),
  ...(sessionIdShort ? [<Text color="planMode" key="session-id">
    ⎔ {sessionIdShort}
  </Text>] : []),
]
const trailingParts = [
  ...(cwdTail ? [<Text color="success" key="cwd-tail">{cwdTail}</Text>] : []),
  ...(remoteSessionUrl ? [<Link url={remoteSessionUrl} key="remote">
    <Text color="ide">{figures.circleDouble} remote</Text>
  </Link>] : []),
]
\`\`\`

4 色（橙 / 蓝 / 青 / 绿）互不冲突，映射语义明确，分隔符继续由
\`renderFooterRow\` 统一以 dimColor 渲染。
`

export function registerUiThemeSkill(): void {
  registerBundledSkill({
    name: 'ui-theme',
    description:
      '修改 Ink/React 组件（状态栏 pill、对话框、提示文本等）颜色时的复用指南：从 src/utils/theme.ts 选已有色位、避免 dimColor 与 color 并用、动态色冲突检查、状态栏标准语义映射（claude/ide/planMode/success 等）。',
    userInvocable: true,
    async getPromptForCommand(args) {
      let prompt = UI_THEME_PROMPT
      if (args) {
        prompt += `\n\n## User Request\n\n${args}`
      }
      return [{ type: 'text', text: prompt }]
    },
  })
}
