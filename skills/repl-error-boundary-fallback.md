# REPL 错误边界与 Fallback Mode 排查

## 适用场景

当 Claude Code 启动或运行过程中出现以下黄色/红色提示时:

```
REPL entered restored fallback mode.
<错误信息>
The main screen subtree failed during startup. This session stays open so missing modules can be restored incrementally.
```

这说明 REPL 渲染树中的某个 React 组件在 render 阶段抛出了未处理异常, 被 `ReplRuntimeBoundary` 错误边界捕获, 整个 UI 降级为 fallback 占位。

## 错误边界机制

### 捕获链路

```
REPL 组件 (src/screens/REPL.tsx)
  └─ ReplRuntimeBoundary (class component, line 529-557)
       ├─ getDerivedStateFromError(error) → { error }
       ├─ componentDidCatch(error, errorInfo)
       │    ├─ logForDebugging("[REPL:boundary] " + error.stack)
       │    ├─ logForDebugging("Component stack: " + errorInfo.componentStack)
       │    ├─ console.error(...) → stderr 可直接在终端看到
       │    └─ logError(error) → 写入错误日志文件
       └─ render()
            └─ 有 error → 渲染 fallback UI（黄色提示文字）
```

### React 组件栈

`componentDidCatch` 的第二个参数 `errorInfo.componentStack` 是定位 bug 的最关键信息。它会显示类似:

```
Component stack:
    at StatusBar (src/components/StatusBar.tsx:8)
    at REPL (src/screens/REPL.tsx:604)
    at App (src/components/App.tsx:32)
```

这直接告诉你是哪个组件的 render 方法抛出了异常。

## 常见错误类型

### 1. `<Box> can't be nested inside <Text> component`

**原因**: Ink 渲染规则被违反（详见 `ink-box-text-nesting-guard` skill）

**降级修复**: `src/ink/reconciler.ts:338` 已将 throw 改为 console.warn, 不应再触发此错误。如果仍然出现, 说明有新代码绕过了降级逻辑。

### 2. `Text string "xxx" must be rendered inside <Text> component`

**原因**: 裸文本字符串出现在 `<Box>` 的直接子级, 没有被 `<Text>` 包裹。

**修复**: 用 `<Text>` 包裹裸字符串。

```tsx
// 错误
<Box>Hello World</Box>

// 正确
<Box><Text>Hello World</Text></Box>
```

### 3. 模块加载失败 (`Cannot find module`, `xxx is not a function`)

**原因**: 还原代码中某个 `require()` 或 `import()` 的模块路径不正确, 或 shim 包缺失。

**排查**:
```bash
# 检查对应模块是否存在
ls src/components/Xxx.tsx
# 检查 shim 包
ls shims/
```

### 4. Hook 调用顺序错误 (`Rendered more/fewer hooks than during previous render`)

**原因**: 条件渲染中 Hook 调用顺序不一致。常见于 `feature()` 编译时常量保护的 Hook 在运行时被条件化。

## 排查步骤

### Step 1: 获取完整错误信息

错误信息会输出到三个地方:
1. **终端 stderr**: `console.error("[REPL:boundary] ...")` — 直接可见
2. **logForDebugging**: 写入调试日志
3. **logError**: 写入错误日志文件

关注两条关键信息:
- **error.stack**: JS 调用栈, 指向代码中 throw 的位置
- **componentStack**: React 组件栈, 指向渲染树中触发错误的组件

### Step 2: 根据 componentStack 定位源组件

组件栈的第一行就是出错的组件。打开该组件的源码, 检查其 `render` 或函数体。

### Step 3: 检查组件的渲染逻辑

常见检查项:
- 是否有 `<Box>` 嵌套在 `<Text>` 内
- 是否有裸字符串在 `<Box>` 内
- 是否有条件分支导致 Hook 数量不一致
- 是否有 undefined/null 对象访问

### Step 4: 修复并验证

```bash
bun run dev  # 重启验证
```

## 防御性编码建议

### 对新增组件

```tsx
// 推荐: 用 try-catch 包裹可能失败的子组件导入
let MyComponent: React.ComponentType<any>;
try {
  MyComponent = require("../components/MyComponent").default;
} catch {
  MyComponent = () => <Text dimColor>MyComponent unavailable</Text>;
}
```

### 对 tool UI 的 renderToolUseMessage

```tsx
// 只返回 string 或 <Text>, 永远不返回 <Box>
export function renderToolUseMessage(input: any): React.ReactNode {
  return `Processing ${input.name}`;  // 安全: 返回字符串
}
```

### 对新增的 reconciler 校验

如果需要在 `src/ink/reconciler.ts` 中增加新的校验规则, 遵循**降级优先**原则:
- 不要 `throw` — 会导致整个 UI 崩溃
- 用 `console.warn` + 全局去重标记
- 让渲染继续, 布局异常远好于完全不可用

## 关键文件

| 文件 | 作用 |
|------|------|
| `src/screens/REPL.tsx:529-557` | ReplRuntimeBoundary 定义 |
| `src/screens/REPL.tsx:5077` | 错误边界包裹整个 mainReturn |
| `src/ink/reconciler.ts:331-372` | createInstance / createTextInstance 校验逻辑 |
| `src/utils/log.ts` | logForDebugging / logError 实现 |
