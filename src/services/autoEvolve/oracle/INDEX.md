# `src/services/autoEvolve/oracle/` 模块索引

## 模块定位

`oracle/` 是自演化系统的评估与调参中心，负责 fitness 观测、ledger、阈值调优、联合调参和 meta-evolver。

## 文件分组

### 观测与评分

- `fitnessObserver.ts`
- `fitnessOracle.ts`
- `goodhartGuard.ts`
- `oracleAggregator.ts`

### Ledger / 数据沉淀

- `benchmarkLedger.ts`
- `ndjsonLedger.ts`
- `sessionOrganismLedger.ts`

### 调优器

- `thresholdTuner.ts`
- `rollbackThresholdTuner.ts`
- `oracleDecayTuner.ts`
- `jointTuningCoordinator.ts`

### 元进化

- `metaEvolver.ts`

## 关联模块

- 上级总览： [../INDEX.md](../INDEX.md)
- Arena： [../arena/INDEX.md](../arena/INDEX.md)
- Emergence： [../emergence/INDEX.md](../emergence/INDEX.md)
