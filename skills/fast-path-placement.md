# 快速路径优化的位置原则

## 核心教训

**快速路径（fast path）检测必须在重量级操作之前执行，否则优化无效。**

这是从"打招呼场景系统提示词优化"的首次实现中吸取的真实教训：

### 反面案例（首次实现）

```typescript
// ❌ 错误：先执行所有重操作，再检测是否需要走快速路径
queryCheckpoint('query_context_loading_start');
const [,, defaultSystemPrompt, baseUserContext, systemContext] = await Promise.all([
  getSystemPrompt(...),   // ~数百毫秒：生成完整系统提示词
  getUserContext(),        // ~数十毫秒：加载 CLAUDE.md、memory 等
  getSystemContext(),      // ~数十毫秒：获取 git status 等
]);
queryCheckpoint('query_context_loading_end');

// 然后才检测——但重操作已经执行完了
const isGreeting = isGreetingMessage(userText)
const effectivePrompt = isGreeting ? getGreetingSystemPrompt() : defaultSystemPrompt
```

**结果**：虽然最终发给 API 的 system prompt 变小了（节省了 token），但是本地耗时几乎不变，用户体验的"响应慢"问题没有解决。

### 正面案例（修复后）

```typescript
// ✅ 正确：先做廉价的检测，命中则跳过所有重操作
queryCheckpoint('query_context_loading_start');

// 廉价操作：字符串匹配，微秒级
const isGreeting = greetingCheckMessages.length === 1
  && messagesIncludingNewMessages.filter(m => m.type === 'user' && !m.isMeta).length === 1
  && isGreetingMessage(greetingCheckMessages[0])

let defaultSystemPrompt: string[]
let userContext: Record<string, string>
let systemContext: Record<string, string>

if (isGreeting) {
  // 快速路径：跳过所有重量级加载
  defaultSystemPrompt = getGreetingSystemPrompt()
  userContext = {}
  systemContext = {}
} else {
  // 正常路径：只在非快速路径情况下执行重操作
  const [,, fullSystemPrompt, baseUserContext, fullSystemContext] = await Promise.all([...])
  defaultSystemPrompt = fullSystemPrompt
  // ...
}
queryCheckpoint('query_context_loading_end');
```

## 判断清单：在实施"快速路径"优化时

1. **检测成本是否远低于重操作？** 只有在检测本身足够便宜（字符串比较、条件判断、简单 lookup）时，前置检测才有意义。
2. **重操作是否真的被跳过？** 不要只替换输出——要让代码分支直接 return 或 else 掉所有昂贵的 `await` / 计算。
3. **检测条件是否足够严格？** 防止正常路径被误判走了快速路径导致功能缺失。例如打招呼检测要求"整个会话只有一条用户消息"，避免对话中的 "hi" 触发。
4. **快速路径的副作用是否一致？** 如果快速路径跳过了某些必需的初始化（如权限检查、遥测），需要显式处理或明确文档化。

## 可复用的检测模式

对于"用户输入特征"类的快速路径，在 `REPL.tsx` 中可以复用同一套文本提取逻辑：

```typescript
const userTexts = newMessages
  .filter((m): m is UserMessage => m.type === 'user' && !m.isMeta)
  .map(_ => getContentText(_.message.content))
  .filter((_): _ is string => _ !== null)
```

可在此基础上扩展的快速路径场景：
- **打招呼**：`isGreetingMessage()` — 已实现
- **道谢/告别**："thanks"、"bye"、"再见"、"谢谢" — 同样无需工具和上下文
- **纯问候扩展**："how are you"、"最近怎么样" — 精简回复
- **帮助命令**："what can you do"、"你能做什么" — 使用固定简介而非完整系统提示词

## 位置原则的通用表述

> 任何条件性降级（fast path、cache hit、no-op short-circuit）都必须在它所要跳过的昂贵操作**之前**判定。
> 如果检测发生在昂贵操作之后，那它只是"替换输出"，不是"优化性能"。

## 关键代码位置

| 功能 | 文件 | 位置 |
|------|------|------|
| 打招呼快速路径检测 | `src/screens/REPL.tsx` | `onQueryImpl()` 中 `query_context_loading_start` 之后 |
| 检测函数 | `src/constants/prompts.ts` | `isGreetingMessage()` |
| 快速路径系统提示词 | `src/constants/prompts.ts` | `getGreetingSystemPrompt()` |

## 相关 skill

- [greeting-system-prompt.md](greeting-system-prompt.md) — 打招呼优化的具体实现
- [third-party-performance-tuning.md](third-party-performance-tuning.md) — 其他性能优化手段
- [native-fallback-chain.md](native-fallback-chain.md) — native 模块快速路径的降级策略（另一种 fast path）
- [image-paste-troubleshooting.md](image-paste-troubleshooting.md) — 图片粘贴链路中 native/osascript 双路径的位置关系
