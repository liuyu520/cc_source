# `src/commands/review/` 模块索引

## 模块定位

`src/commands/review/` 是 `/review` 与 `/ultrareview` 相关的本地/远程评审支持模块。

注意主命令元数据入口不在本目录，而在上层文件 `../review.ts`。

## 文件清单

- `reviewRemote.ts`
  远程评审发起
- `ultrareviewCommand.tsx`
  `/ultrareview` 本地 JSX 入口与 overage gate
- `ultrareviewEnabled.ts`
  开关判断
- `UltrareviewOverageDialog.tsx`
  额度确认对话框

## 关联模块

- 上层命令入口： `src/commands/review.ts`
- 组件与远程会话： [../../components/INDEX.md](../../components/INDEX.md)、[../../tasks/INDEX.md](../../tasks/INDEX.md)
