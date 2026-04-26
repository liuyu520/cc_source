# `src/ink/` 模块索引

## 模块定位

`src/ink/` 是该仓库内的 TUI 渲染底座，负责终端输出、布局、光标、按键事件、组件渲染与屏幕刷新。

规模概览：约 100 个文件，是 `src/components/` 的底层支撑。

## 关键文件

- `ink.tsx`
  核心导出
- `renderer.ts`、`render-to-screen.ts`、`render-node-to-output.ts`
  渲染主链
- `root.ts`、`screen.ts`
  根节点与屏幕抽象
- `parse-keypress.ts`
  键盘事件解析

## 子域划分

### 渲染核心

- `renderer.ts`
- `render-border.ts`
- `render-node-to-output.ts`
- `render-to-screen.ts`
- `output.ts`

### 布局与测量

- `measure-element.ts`
- `measure-text.ts`
- `get-max-width.ts`
- `layout/`

### 输入与事件

- `parse-keypress.ts`
- `events/`
- `hooks/`
- `focus.ts`
- `hit-test.ts`

### 终端能力

- `termio/`
- `cursor.ts`
- `clearTerminal.ts`
- `log-update.ts`

### 组件与视觉工具

- `components/`
- `colorize.ts`
- `searchHighlight.ts`

## 关联模块

- 上层组件： [../components/INDEX.md](../components/INDEX.md)
- 快捷键与输入： [../hooks/INDEX.md](../hooks/INDEX.md)、[../keybindings/INDEX.md](../keybindings/INDEX.md)
- 应用状态： [../state/INDEX.md](../state/INDEX.md)
