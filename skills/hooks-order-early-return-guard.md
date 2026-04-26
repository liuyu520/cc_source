# React Hooks 顺序与早返回守卫

## 适用场景

当 REPL 出现以下典型 fallback 报错，且触发条件是「按某个键 / 切到某个模式 / 打开某个面板」时：

```
REPL entered restored fallback mode.
Rendered fewer hooks than expected. This may be caused by an accidental early return statement.
The main screen subtree failed during startup.
```

这是 React Hooks 规则违反（Rules of Hooks）。本项目中 PromptInput 系列组件有大量「模式早返回」分支（bash/vim/fastMode/modelPicker/quickOpen…），任何在早返回之后新增的 `useXxx()` 调用都会在模式切换时导致 Hook 数量不一致。

## 真实案例（2026-04）

输入英文 `!` 进入 bash 模式后直接 fallback。

**根因**：`src/components/PromptInput/PromptInputFooterLeftSide.tsx`

```tsx
// L371 早返回
if (mode === 'bash') {
  return <Text color="bashBorder">! for bash mode</Text>;
}
...
// L414 —— ❌ 早返回之后的 Hook 调用
const gitBranch = useGitBranch();
```

非 bash 模式：组件调用 N 个 hooks。
切到 bash：早返回，只调用 N-1 个 hooks → React 抛 "Rendered fewer hooks than expected"。

**修复**：把 Hook 前移到早返回之前，与其它 `useAppState` 同级。普通变量（`getAuthIdentityLabel()`、`getSessionId()` 等纯函数）留在原地即可。

## 定位步骤

1. 根据触发键/模式，先锁定组件。典型触发：
   - `!` → bash 模式 → `PromptInputFooterLeftSide` / `PromptInputModeIndicator` / `PromptInput` 的 bash 分支
   - `Esc` / `Tab` → autocomplete / vim
   - 打开 picker → `modelPickerElement` / `fastModePickerElement` / `QuickOpenDialog` 等
2. 在该组件搜索 `if (.*) return` 和 `return <`，列出所有早返回位置。
3. 对每个早返回，用 `awk 'NR>=<line>' file | grep -nE "use[A-Z][a-zA-Z]*\("` 检查后续是否还有 Hook 调用。
4. 任何命中都是潜在 bug，必须将这些 Hook 前移到最早的早返回之前。

## 预防规则

- **新增 Hook 一律放在组件顶部** 所有其它 `useState` / `useAppState` / 自定义 hook 同一区段内。
- **纯函数调用可以留在底部**（例如 `getAuthIdentityLabel()`、`getCwdState()`、`getSessionId()`），不会引发 Hook 顺序问题。
- **三元 Hook 只在 `feature()` 这种编译期常量下允许**（已有 `biome-ignore lint/correctness/useHookAtTopLevel` 标注模式），不要在运行时条件下写 `cond ? useX() : null`。
- **Code review 清单**：修改/新增 PromptInput 下任意组件时，grep 所有 `mode === 'bash' / vim / ...` 分支，确认自己的 Hook 在它们之前。

## 复用的现有能力

- `ReplRuntimeBoundary`（`src/screens/REPL.tsx`）会把错误写入 debug log 与 stderr，调试时先看终端输出即可拿到完整 stack；详见 `skills/repl-error-boundary-fallback.md`。
- `bun run dev:restore-check` 只检查 import 缺失，**不会**检查 Hook 顺序，不要依赖它兜底。

## 相关 Skill

- `repl-error-boundary-fallback.md` —— fallback 文案解读与日志定位
- `ink-box-text-nesting-guard.md` —— 另一类常见 render 期抛错
