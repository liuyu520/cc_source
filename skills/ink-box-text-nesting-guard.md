# Ink 渲染引擎 Box/Text 嵌套规则与防崩溃降级

## 适用场景

当 REPL 界面突然崩溃并显示以下错误信息时:

```
REPL entered restored fallback mode.
<Box> can't be nested inside <Text> component
The main screen subtree failed during startup. This session stays open so missing modules can be restored incrementally.
```

这是 Ink（终端 React 渲染引擎）的一条渲染规则被违反: `<Box>` 是块级元素, `<Text>` 是内联元素, Ink 禁止在 `<Text>` 内部嵌套 `<Box>`（类似 HTML 中 `<span>` 不能包含 `<div>`）。

## 核心机制

### 1. hostContext 传播链

Ink reconciler 通过 React 的 host context 机制追踪当前是否在 `<Text>` 内部:

```
src/ink/reconciler.ts — getChildHostContext():
  isInsideText = (type === 'ink-text' || type === 'ink-virtual-text' || type === 'ink-link')
```

一旦进入 `<Text>` / `<VirtualText>` / `<Link>`, 其所有子组件的 `hostContext.isInsideText` 都为 `true`。

### 2. 校验与拦截点

```
src/ink/reconciler.ts — createInstance():
  if (hostContext.isInsideText && originalType === 'ink-box') {
    // 原始行为: throw Error — 导致整棵 REPL 子树崩溃
    // 降级后行为: console.warn + 继续渲染 — UI 可能布局异常但不崩溃
  }
```

### 3. 错误被捕获的位置

```
src/screens/REPL.tsx — class ReplRuntimeBoundary:
  static getDerivedStateFromError(error) → 设置 error state
  componentDidCatch(error, errorInfo) → 记录 error.stack + React componentStack
  render() → 渲染 fallback: "REPL entered restored fallback mode."
```

## 常见违规模式

### 模式 A: 直接嵌套（静态，易发现）

```tsx
// 错误
<Text dimColor>
  Claude Code
  <Box marginLeft={1}>         {/* <- Box 在 Text 内部 */}
    <Text>Press /help</Text>
  </Box>
</Text>

// 正确: 把 Box 提到 Text 外面作为兄弟
<Box>
  <Text dimColor>Claude Code</Text>
  <Box marginLeft={1}>
    <Text>Press /help</Text>
  </Box>
</Box>
```

### 模式 B: 通过 children/ReactNode prop 间接嵌套（动态，难发现）

```tsx
// 危险: renderToolUseMessage() 的返回值被包在 <Text> 里
t10 = renderedToolUseMessage !== "" &&
  <Box flexWrap="nowrap">
    <Text>({renderedToolUseMessage})</Text>   {/* <- 如果返回值含 Box 就炸 */}
  </Box>

// 对应源码位置: src/components/messages/AssistantToolUseMessage.tsx:210
```

这种模式的危险在于: 只要某个工具（特别是 MCP 工具或第三方插件）的 `renderToolUseMessage()` 返回了包含 `<Box>` 的 ReactNode, 就会触发错误。这是间歇性触发的典型原因。

### 模式 C: 组件被复用到不同上下文

```tsx
// 某组件内部渲染了 <Box>
function StatusIcon() {
  return <Box><Text>icon</Text></Box>  // 内部有 Box
}

// 在 Box 上下文中使用 — 安全
<Box><StatusIcon /></Box>

// 在 Text 上下文中使用 — 炸
<Text><StatusIcon /></Text>
```

## 诊断方法

### 1. 查看 console.warn 日志

降级修复后, 违规不再 throw 而是打印一次 warning:

```
[ink] <Box> nested inside <Text> detected; rendering downgraded.
This usually means some component returns <Box> from inside a <Text> wrapper.
Stack:
  at createInstance (src/ink/reconciler.ts:346:...)
  at ... (具体触发组件的调用栈)
```

### 2. 查看 ReplRuntimeBoundary 的 componentStack

如果有其他渲染错误导致进入 fallback mode, 增强后的边界会同时打印:
- `error.stack` — JS 调用栈（指向 throw 位置）
- `errorInfo.componentStack` — React 组件栈（指向渲染树中哪个组件触发的）

### 3. 手动排查

```bash
# 搜索所有 .tsx 中 <Box 出现在 <Text> 闭合之前的模式
grep -rn "<Text" src/components/ src/screens/ --include="*.tsx" | \
  while read line; do
    file=$(echo "$line" | cut -d: -f1)
    grep -n "<Box" "$file" | head -5
  done
```

核心思路: 从 `<Text>` 标签开始, 在其关闭 `</Text>` 之前如果出现 `<Box>` 或者调用了可能返回 `<Box>` 的组件, 就是违规点。

## 关键文件

| 文件 | 作用 |
|------|------|
| `src/ink/reconciler.ts:338` | 校验 + 降级（原 throw 改为 warn） |
| `src/screens/REPL.tsx:529-557` | ReplRuntimeBoundary 错误边界 |
| `src/components/messages/AssistantToolUseMessage.tsx:210` | 最高风险的动态嵌套点 |
| `src/tools/*/UI.tsx` — `renderToolUseMessage()` | 各工具的消息渲染函数 |

## 编写新组件的规则

1. **`<Text>` 内部只允许**: 其他 `<Text>`, `<Link>`, 纯文本字符串
2. **`<Text>` 内部禁止**: `<Box>`, 任何可能渲染 `<Box>` 的组件
3. **如果需要布局(margin/padding/flexbox)**: 在 `<Text>` 外层用 `<Box>` 包裹
4. **编写接受 `children: ReactNode` 的组件时**: 如果用 `<Text>` 包裹 children, 必须文档说明 children 不能含 `<Box>`
5. **编写 `renderToolUseMessage()`**: 只返回 `string` 或纯 `<Text>` 嵌套, 永远不返回 `<Box>`
