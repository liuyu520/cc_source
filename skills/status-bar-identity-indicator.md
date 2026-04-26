# 状态栏身份 / 分支指示器

底部 footer（`►► bypass permissions on (shift+tab to cycle) · esc to interrupt`）支持追加"当前使用模式 / 登录身份 / git 分支"等上下文 pill。本文记录接入方式、复用点与常见陷阱。

## 架构快速定位

| 角色 | 文件 | 关键符号 |
|------|------|----------|
| Footer 容器 | `src/components/PromptInput/PromptInputFooter.tsx` | `PromptInputFooter` |
| 左侧渲染（mode + pills + hint） | `src/components/PromptInput/PromptInputFooterLeftSide.tsx` | `ModeIndicator`（~L237）|
| 右侧通知 | 同上 | `Notifications` / `BridgeStatusIndicator` |
| 中点分隔符 | `src/components/design-system/Byline.tsx` | `Byline` |
| 快捷键提示 | `src/components/design-system/KeyboardShortcutHint.tsx` | `KeyboardShortcutHint` |

`ModeIndicator` 内部通过 `parts: React.ReactElement[]` 收集 pill，最后 `<Byline>{parts}</Byline>` 用中点串联。新增 pill 只需 push 到 `parts` 数组即可，**不要**往 `modePart`（权限模式）或 `tasksPart`（后台任务）里塞，它们是独立 Box。

## 接入新 pill 的标准姿势

在 `parts` 初始化处（remoteSessionUrl 之前）插入：

```tsx
const myLabel = getMyLabel(); // 同步 or 来自 hook
const parts = [
  ...(myLabel ? [<Text dimColor key="my-label">{myLabel}</Text>] : []),
  ...(remoteSessionUrl ? [...] : []),
  // ...existing
];
```

**约束**：
- 必须有唯一 `key`
- 外层是 `<Text>` 而非 `<Box>`（`parts` 最终进入 `<Text wrap="truncate">`，Box-in-Text 会触发 Ink reconciler 异常，见 `skills/ink-box-text-nesting-guard.md`）
- 条件渲染用 spread `...(cond ? [jsx] : [])`，避免 `null` 进入数组
- 若 pill 有交互 / Box 布局，按 `BackgroundTaskStatus` 模式改为独立 sibling Box

## 已实现 pill 复用表

### 1. 认证身份 / 使用模式

函数位置：`PromptInputFooterLeftSide.tsx` 顶部 `getAuthIdentityLabel()`。全部复用已有 API，零新增副作用：

| 场景 | 判定 | 显示 |
|------|------|------|
| 第三方 API | `getAPIProvider() === 'thirdParty'` | `new URL(ANTHROPIC_BASE_URL).host` 或 `API Usage Billing` |
| Bedrock / Vertex / Foundry | 同上 | `AWS Bedrock` / `Google Vertex` / `Azure Foundry` |
| OAuth 邮箱登录 | `getAuthTokenSource().source === 'claude.ai'` | `getOauthAccountInfo()?.emailAddress` |
| 纯 API Key / Token | `authSource ∈ { ANTHROPIC_AUTH_TOKEN, apiKeyHelper, CLAUDE_CODE_OAUTH_TOKEN* }` | `API Usage Billing` |

关联 skill：`api-provider-detection.md`（provider 判定规则）。

### 2. 当前 git 分支

Hook：`src/hooks/useGitBranch.ts`

- 复用 `utils/git.ts` 的 `getBranch()` + `getIsGit()`（底层 `gitWatcher` 缓存，命中零开销）
- 5s 轮询 + 首次 mount 立即触发；非 git 仓库返回 `null`
- 失败静默，避免分支显示闪烁

渲染：`<Text dimColor>⎇ {branch.slice(-10)}</Text>`，位于认证身份 pill 之后。长分支名只取后 10 字符（如 `main20260331` → `n20260331`），尾部通常承载日期或序号语义。

### 3. 当前会话 ID（/resume 兼容）

直接复用 `src/bootstrap/state.ts` → `getSessionId()`（同一来源被 `/resume`、swarm `--parent-session-id`、teleport `sessionId` 使用，无需新增状态）。

- render 内同步调用：`const sessionIdShort = getSessionId().slice(0, 8)`
- 渲染：`<Text dimColor>⎔ {sessionIdShort}</Text>`，位于 git 分支 pill 之后
- `regenerateSessionId()` 触发时（如 `/clear`）组件会因其他 state 变化自然重渲染；若需强一致可改 hook 订阅，但目前无订阅 API，避免过度设计
- **不要**显示完整 UUID（占 36 字符，会挤占 hint），8 位已满足 `/resume` 前缀匹配习惯

## 举一反三：可直接复用的上下文源

若后续要加其他 pill，**优先复用已有缓存层**，不要直接 spawn 子进程：

| 数据 | 已有源 | 备注 |
|------|--------|------|
| git 分支 / HEAD / remote / 默认分支 | `utils/git.ts` → `getBranch/getHead/getRemoteUrl/getDefaultBranch` | 走 `gitWatcher` |
| PR 状态 | `hooks/usePrStatus.ts` | 已在 footer 使用，注意 4s 慢检测自动禁用 |
| 订阅类型 / 组织名 | `utils/auth.ts` → `getOauthAccountInfo()` / `getSubscriptionName()` | 只对 firstParty 有效 |
| Provider | `utils/model/providers.ts` → `getAPIProvider()` / `isProxyMode()` | 纯同步，零开销 |
| 模型名 | `utils/model/model.ts` → `getMainLoopModel()` | 尊重 `ANTHROPIC_MODEL` |
| 是否远程 session | `bootstrap/state.ts` → `getIsRemoteMode()` | remote 模式下 mode pill 会隐藏 |
| 终端宽度 | `hooks/useTerminalSize.ts` | 用于窄屏降级 |

**异步源**必须封装成 hook（useState + useEffect），不要在 render 里直接 `await`。参考 `usePrStatus` 的惰性轮询 + idle stop 模式，或简化版 `useGitBranch`。

## Pill 长度约定

footer 空间紧张，每个 pill 都应自带截断策略，避免挤掉 hint / 触发中点换行：

| Pill | 截断规则 | 理由 |
|------|----------|------|
| auth-identity | `label.slice(0, 10)` | 邮箱前缀、host 前 10 字符已可辨识账号 |
| git-branch | `branch.slice(-10)` | 长分支命名（如 `main20260331`、`feature/xxx-20260401`）尾部承载语义 |
| session-id | `getSessionId().slice(0, 8)` | UUID 前 8 位匹配 `/resume` 前缀习惯 |
| cwd-tail | `getCwdState().slice(-10)` | 路径尾部承载项目名，复用 `bootstrap/state.ts` 的 cwd 状态（感知 EnterWorktree 切换）|

新增 pill 时遵循同样原则：**固定长度 ≤ 10**，前截还是后截按语义信息分布决定（前缀更稳 → 前截；日期/序号在尾 → 后截）。不要用 `…` 省略号占额外字符。

## 窄屏 / 拥挤处理

`ModeIndicator` 已有 `primaryItemCount` 和 `columns >= 80` 判定：

- 主 pill 数 ≥ 2 时隐藏 `shift+tab to cycle` 提示
- PR badge 在 `columns < 80 && primaryItemCount > 0` 时隐藏

新增的非关键 pill 遵循同样原则：在 `columns < 80` 或 `parts.length > N` 时考虑省略，避免截断中点分隔符。

## 常见陷阱

1. **Box 嵌在 Text 里** → Ink reconciler 抛错。`parts` 中一律用 `<Text>`，要 Box 的走 sibling。
2. **忘记 `key`** → React 警告 + 可能的 diff 错位。
3. **同步调用异步 git/网络** → 卡渲染。改为 hook + useEffect。
4. **直接读 `process.env.ANTHROPIC_BASE_URL` 判断 provider** → 漏 Bedrock/Vertex/Foundry。用 `getAPIProvider()`。
5. **把身份 pill 放到 `modePart`** → 和权限模式色串一起显示。应该走 `parts` 用 `dimColor`。
6. **Remote session 下显示本地身份** → 会误导（agent 在远端）。如需 remote-aware，判断 `getIsRemoteMode()`。
7. **getOauthAccountInfo() 对第三方 provider 返回 undefined** → 不要假定有 email。先判断 provider / source。

## 验证方式

无 lint / test，只能 smoke：

```bash
# 语法检查（不会报 Browser build 那类无关错误）
bun build --target=bun --no-bundle src/components/PromptInput/PromptInputFooterLeftSide.tsx 2>&1 | grep -i error

# 实跑
bun run dev
# 切换不同 ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY / OAuth 组合验证 pill 切换
# 在 git 仓库外启动验证 gitBranch=null 时 pill 消失
```

## 相关 skills

- `api-provider-detection.md` — provider 分支逻辑
- `oauth-proxy-implementation.md` — OAuth 代理等价性
- `ink-box-text-nesting-guard.md` — Box/Text 嵌套规则
- `keybinding-system-architecture.md` — footer 快捷键提示来源
