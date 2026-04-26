# `src/services/autoEvolve/emergence/` 模块索引

## 模块定位

`emergence/` 负责把运行过程中的现象沉淀为可归档、可晋升、可复用的结构，包括模式挖掘、技能编译、回滚观察与 warmstart 库。

## 文件清单

- `autoArchiveEngine.ts`
- `archiveRetrospective.ts`
- `archiveThresholdTuner.ts`
- `autoPromotionEngine.ts`
- `promotionThresholdTuner.ts`
- `patternMiner.ts`
- `skillCompiler.ts`
- `rollbackWatchdog.ts`
- `warmstartLibrary.ts`
- `bodyRenderers.ts`

## 作用概括

- `autoArchive*` / `archive*`
  归档与阈值调优
- `autoPromotionEngine.ts`
  晋升决策链
- `patternMiner.ts`
  模式抽取
- `skillCompiler.ts`
  将经验/模式编译成技能资产
- `rollbackWatchdog.ts`
  回滚监测

## 关联模块

- 上级总览： [../INDEX.md](../INDEX.md)
- 评分与调优： [../oracle/INDEX.md](../oracle/INDEX.md)
