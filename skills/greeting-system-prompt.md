# 打招呼场景系统提示词优化

当用户输入简单的打招呼语（如 "hi"、"hello"、"你好"）时，系统自动使用精简的系统提示词替代完整提示词，大幅减少 token 消耗。

## 工作原理

### 检测流程

```
用户输入 → 提取纯文本 → 去标点/空格/小写化 → 匹配打招呼语列表 → 选择系统提示词
```

在 `REPL.tsx` 的 `onQueryImpl` 中，`buildEffectiveSystemPrompt()` 之前进行拦截：

1. 从 `newMessages` 中过滤出非 meta 的用户消息
2. 提取文本内容（`getContentText`）
3. 检查是否只有一条消息且匹配打招呼语
4. 如果匹配，用 `getGreetingSystemPrompt()` 替代 `defaultSystemPrompt`

### 检测逻辑

**文件**: `src/constants/prompts.ts` `isGreetingMessage()`

```typescript
// 标准化处理：去除尾部标点和空格，转小写
const normalized = text.trim().toLowerCase().replace(/[!！?？.。,，~～\s]+$/g, '').trim()
return GREETING_PATTERNS.includes(normalized)
```

支持的打招呼语：
- 英文: `hi`, `hello`, `hey`, `hola`, `bonjour`, `yo`, `sup`, `whats up`, `what's up`
- 中文: `你好`, `嗨`, `哈喽`, `早上好`, `下午好`, `晚上好`, `早`, `嘿`
- 日文: `こんにちは`, `おはよう`
- 其他: `hola`（西班牙语）, `bonjour`（法语）, `hej`（瑞典/丹麦语）

### 简单系统提示词内容

**文件**: `src/constants/prompts.ts` `getGreetingSystemPrompt()`

仅包含：
- 基本身份（Claude Code）
- 工作目录和日期
- 回复指引：简短友好，使用用户语言

**不包含**：完整工具说明、编码规范、安全指令、memory、环境详情、MCP 指令等。

### 拦截位置

**文件**: `src/screens/REPL.tsx` `onQueryImpl()`

检测在 `Promise.all`（加载完整系统提示词、用户上下文、系统上下文）**之前**执行，确保打招呼时跳过所有重量级操作：

```typescript
// 打招呼检测：提前到重量级上下文加载之前，避免无谓的 token 和时间消耗
const greetingCheckMessages = newMessages
  .filter((m): m is UserMessage => m.type === 'user' && !m.isMeta)
  .map(_ => getContentText(_.message.content))
  .filter((_): _ is string => _ !== null)
const isGreeting = greetingCheckMessages.length === 1
  && messagesIncludingNewMessages.filter(m => m.type === 'user' && !m.isMeta).length === 1
  && isGreetingMessage(greetingCheckMessages[0])

if (isGreeting) {
  // 快速路径：跳过 getSystemPrompt、getUserContext、getSystemContext
  defaultSystemPrompt = getGreetingSystemPrompt()
  userContext = {}
  systemContext = {}
} else {
  // 正常路径：执行完整的 Promise.all 加载
}
```

关键：`messagesIncludingNewMessages` 中只有一条非 meta 用户消息时才走快速路径，确保对话中后续消息不会误判。

## 效果

| 指标 | 打招呼（优化后） | 正常查询 |
|------|-----------------|---------|
| 系统提示词 | ~100 tokens | ~15,000-30,000 chars |
| 响应速度 | 快 | 正常 |
| 工具可用 | 全部（不影响工具集） | 全部 |

注意：该优化只替换 `defaultSystemPrompt`，不影响 `customSystemPrompt`、`appendSystemPrompt` 和 `mainThreadAgentDefinition` 的处理逻辑。

## 扩展打招呼语列表

在 `src/constants/prompts.ts` 的 `GREETING_PATTERNS` 数组中添加新的打招呼语（小写形式）：

```typescript
const GREETING_PATTERNS: string[] = [
  'hi', 'hello', 'hey', ...
  'new_greeting',  // ← 添加到这里
]
```

## 关键代码位置

| 功能 | 文件 | 函数/常量 |
|------|------|----------|
| 打招呼语列表 | `src/constants/prompts.ts` | `GREETING_PATTERNS` |
| 打招呼检测 | `src/constants/prompts.ts` | `isGreetingMessage()` |
| 简单系统提示词 | `src/constants/prompts.ts` | `getGreetingSystemPrompt()` |
| 拦截与替换 | `src/screens/REPL.tsx` | `onQueryImpl()` |
