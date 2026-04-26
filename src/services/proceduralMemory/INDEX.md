# `src/services/proceduralMemory/` 模块索引

## 模块定位

`src/services/proceduralMemory/` 负责从工具序列证据中挖掘可复用流程，把频繁模式写成 procedural candidates，并按配置执行 promote。

## 关键文件

- `index.ts`
  运行学习周期与 capture 入口
- `sequenceMiner.ts`
  工具序列捕获与模式挖掘
- `promoter.ts`
  candidate 写入与 promote
- `featureCheck.ts`
  procedural 模式与开关
- `types.ts`
  类型定义

## 现有文档

- `README.md`
  目录内已有额外说明，可和本索引配合阅读

## 关联模块

- harness： [../INDEX.md](../INDEX.md)
- 记忆系统： [../../memdir/INDEX.md](../../memdir/INDEX.md)
