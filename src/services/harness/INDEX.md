# `src/services/harness/` 模块索引

## 模块定位

`src/services/harness/` 是证据账本与验证基础设施，负责 evidence ledger 及其类型，并挂接 PEV 子系统。

## 关键文件

- `index.ts`
  对外聚合入口
- `evidenceLedger.ts`
  证据账本实现
- `evidenceLedgerTypes.ts`
  账本类型
- `featureCheck.ts`
  harness 相关开关

## `pev/` 子目录

PEV 相关能力见 [pev/INDEX.md](./pev/INDEX.md)。

## 关联模块

- Procedural Memory： [../proceduralMemory/INDEX.md](../proceduralMemory/INDEX.md)
- AutoEvolve： [../autoEvolve/INDEX.md](../autoEvolve/INDEX.md)
