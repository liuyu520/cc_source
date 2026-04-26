# `src/services/modelRouter/` 模块索引

## 模块定位

`src/services/modelRouter/` 负责跨 provider / model 的健康、成本与路由决策，是“在多个候选模型之间怎么选”的服务层实现。

## 文件清单

- `index.ts`
  对外入口
- `router.ts`
  路由主逻辑
- `providerMatrix.ts`
  provider 矩阵
- `healthTracker.ts`
  健康度追踪
- `costTracker.ts`
  成本追踪
- `featureCheck.ts`
  开关
- `types.ts`
  类型

## 关联模块

- 模型工具层： [../../utils/model/INDEX.md](../../utils/model/INDEX.md)
- Provider 系统： [../providers/INDEX.md](../providers/INDEX.md)
