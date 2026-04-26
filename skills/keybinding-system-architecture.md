# Keybinding 系统架构与调试

## 目标

理解本项目 keybinding 系统的分层架构，掌握"按键从 stdin 到 handler 被调用"的完整链路，用于调试任何快捷键相关问题。

## 架构分层

```
stdin (raw bytes)
  ↓
tokenizer (src/ink/parse-keypress.ts)
  → ParsedKey: { name, ctrl, meta, shift, super, sequence }
  ↓
input-event (src/ink/events/input-event.ts)
  → InputEvent: { input: string, key: Key, keypress, stopImmediatePropagation }
  → 关键: input = keypress.ctrl ? keypress.name : keypress.sequence
  ↓
useInput priority queue (src/ink/hooks/use-input.ts)
  → 按注册顺序分发给所有 useInput 监听器
  → stopImmediatePropagation() 可中止后续监听器
  ↓
┌─ ChordInterceptor (最先注册，最高优先级)
│   → 处理 chord 序列（如 ctrl+x ctrl+e）
│   → 非 chord 的单键匹配：只 setPendingChord(null)，不调 handler
│   → chord 完成时：从 handlerRegistryRef 找到并调用 handler
│
├─ useKeybindings / useKeybinding (各组件注册)
│   → resolve(input, key, contexts) → match / none / chord_started / ...
│   → match 且 action 匹配自身 → 调用 handler + stopImmediatePropagation
│
├─ usePasteHandler (PromptInput 注册)
│   → 处理 bracketed paste (isPasted=true)、大段文本、图片路径
│
└─ useTextInput (TextInput 注册)
    → 常规字符输入、光标移动、readline 快捷键
```

## 关键设计决策

### 1. ChordInterceptor 与 useKeybindings 的分工

- **ChordInterceptor** 只负责 chord 状态管理和 chord 完成后的 handler 调用
- **非 chord 单键**由各组件自己的 useKeybindings 匹配并调用
- 两者都调用 `resolveKeyWithChordState()` 做匹配，保证一致性

### 2. Context 优先级

```typescript
const contexts = [...handlerContexts, ...activeContexts, 'Global']
```

- Handler 注册的 context 优先级最高
- 然后是 `registerActiveContext` 注册的 context
- 最后是 Global

同一个键在不同 context 有不同绑定时，优先匹配更具体的 context。

### 3. stopImmediatePropagation 机制

```typescript
// match 时阻止后续 listener
if (handler() !== false) {
  event.stopImmediatePropagation()
}
```

- handler 返回 `false` 表示"未消费"，事件继续传播（如 scroll 在内容不足时 fall through）
- handler 返回 `void` 或 `Promise<void>` 视为已消费

### 4. 平台差异

| 平台 | 粘贴键 | 图片粘贴绑定 |
|------|--------|-------------|
| macOS | Cmd+V (bracketed paste) | ctrl+V → `chat:imagePaste` |
| Linux | ctrl+V (bracketed paste) | ctrl+V → 被 paste 和 keybinding 同时看到 |
| Windows | ctrl+V (system paste) | alt+V → `chat:imagePaste` |

**Linux 的特殊情况**: ctrl+V 既是系统粘贴（触发 bracketed paste）又是 keybinding。usePasteHandler 先处理 bracketed paste 内容，useKeybindings 后触发 handleImagePaste。两者不冲突：bracketed paste 如果有内容则走文本/路径逻辑；如果空则走 checkClipboardForImage。

## 添加新 keybinding 的步骤

### 1. 定义 action 名称

`src/keybindings/schema.ts` — 添加到 `CHAT_ACTIONS` / `GLOBAL_ACTIONS` 等数组：

```typescript
export const CHAT_ACTIONS = [
  // ...existing
  'chat:myNewAction',  // 新增
] as const
```

### 2. 注册默认绑定

`src/keybindings/defaultBindings.ts` — 在对应 context 的 bindings 中添加：

```typescript
{
  context: 'Chat',
  bindings: {
    // ...existing
    'ctrl+shift+n': 'chat:myNewAction',
  },
},
```

### 3. 注册 handler

在目标组件中使用 `useKeybinding` 或 `useKeybindings`：

```typescript
// 单个绑定
useKeybinding('chat:myNewAction', handleMyAction, {
  context: 'Chat',
  isActive: !isModalOverlayActive,
})

// 批量绑定（推荐，减少 useInput 调用次数）
const handlers = useMemo(() => ({
  'chat:myNewAction': handleMyAction,
  'chat:anotherAction': handleAnother,
}), [handleMyAction, handleAnother])
useKeybindings(handlers, { context: 'Chat', isActive: !isModalOverlayActive })
```

### 4. 更新帮助菜单

`src/components/PromptInput/PromptInputHelpMenu.tsx` — 使用 `useShortcutDisplay`：

```typescript
const display = useShortcutDisplay('chat:myNewAction', 'Chat', 'ctrl+shift+n')
```

## 调试技巧

### 1. 确认按键是否到达 parse-keypress

在 `parseKeypress()` 前打日志：

```typescript
logForDebugging(`parseKeypress: ${JSON.stringify(s.split('').map(c => c.charCodeAt(0)))}`)
```

### 2. 确认 keybinding 是否匹配

在 `resolveKeyWithChordState()` 前打日志：

```typescript
logForDebugging(`resolve: input=${input}, key=${JSON.stringify({name: key.name, ctrl: key.ctrl, meta: key.meta})}`)
```

### 3. 确认 handler 是否被调用

在 handler 入口打日志：

```typescript
const handleImagePaste = useCallback(() => {
  logForDebugging('[chat:imagePaste] handler invoked')
  // ...
}, [])
```

### 4. 检查事件是否被提前消费

如果 handler 没被调用，检查是否有其他 useInput 监听器先 `stopImmediatePropagation()` 了。常见拦截者：
- **voice hold-to-talk** (`useVoiceIntegration.tsx:492`) — 检查 `voiceKeystroke` 是否匹配
- **ChordInterceptor** — 检查是否误判为 chord 前缀
- **usePasteHandler** — 检查 `isFromPaste` 是否为 true

## 保留键与不可重绑键

`src/keybindings/reservedShortcuts.ts` 定义了不可重绑的快捷键：

```typescript
// ctrl+c, ctrl+d 使用特殊的双击检测逻辑
// 用户尝试重绑这些键时会显示错误
```

在添加新绑定时**避免**使用这些保留键。

## 关键代码位置

| 功能 | 文件 | 说明 |
|------|------|------|
| 按键解析 | `src/ink/parse-keypress.ts` | `parseKeypress()` — 原始字节 → ParsedKey |
| Input 事件 | `src/ink/events/input-event.ts` | `input` 字段的生成规则 |
| 绑定定义 | `src/keybindings/defaultBindings.ts` | 所有默认快捷键 |
| 绑定解析器 | `src/keybindings/parser.ts` | `parseKeystroke()` — 字符串 → ParsedKeystroke |
| 匹配逻辑 | `src/keybindings/match.ts` | `matchesKeystroke()` — ParsedKey vs ParsedKeystroke |
| 解析器 | `src/keybindings/resolver.ts` | `resolveKeyWithChordState()` — 带 chord 状态的解析 |
| Chord 拦截 | `src/keybindings/KeybindingProviderSetup.tsx` | `ChordInterceptor` — chord 序列管理 |
| Hook API | `src/keybindings/useKeybinding.ts` | `useKeybinding()` / `useKeybindings()` |
| 保留键 | `src/keybindings/reservedShortcuts.ts` | 不可重绑的键定义 |

## 相关 skill

- [keybinding-handler-signature-alignment.md](keybinding-handler-signature-alignment.md) — 多入口签名对齐
- [image-paste-troubleshooting.md](image-paste-troubleshooting.md) — 图片粘贴全链路排查
