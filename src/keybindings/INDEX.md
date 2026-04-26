# `src/keybindings/` 模块索引

## 模块定位

`src/keybindings/` 负责快捷键系统，包括默认绑定、用户绑定加载、语法解析、上下文匹配、冲突校验和 UI hook 接口。

## 关键文件

- `defaultBindings.ts`
  默认快捷键集合
- `loadUserBindings.ts`
  用户自定义绑定加载
- `parser.ts`
  快捷键语法解析
- `resolver.ts`
  绑定解析与命中
- `validate.ts`
  校验规则
- `reservedShortcuts.ts`
  保留快捷键

## React / UI 接口

- `KeybindingContext.tsx`
- `KeybindingProviderSetup.tsx`
- `useKeybinding.ts`
- `useShortcutDisplay.ts`

## 设计点

- 该目录是输入层和 UI 层之间的桥梁
- 若快捷键行为异常，往往需要同时检查这里、`src/hooks/` 与 `src/ink/`

## 关联模块

- Hook 层： [../hooks/INDEX.md](../hooks/INDEX.md)
- TUI 渲染： [../ink/INDEX.md](../ink/INDEX.md)
- UI 组件： [../components/INDEX.md](../components/INDEX.md)
