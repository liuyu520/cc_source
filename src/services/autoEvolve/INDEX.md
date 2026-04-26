# `src/services/autoEvolve/` 模块索引

## 模块定位

`src/services/autoEvolve/` 是仓库里最实验化、也最复杂的子系统之一，承载自演化、影子运行、晋升/回滚、经验归档、阈值调优与元进化等逻辑。

## 关键入口

- `index.ts`
  对外总入口
- `featureCheck.ts`
  开关控制
- `paths.ts`
  文件/目录路径约定
- `types.ts`
  全局类型

## 核心子模块

| 子模块 | 作用 | 索引 |
| --- | --- | --- |
| `arena/` | 影子运行、谱系、晋升状态机、隔离与 veto 经验 | [arena/INDEX.md](./arena/INDEX.md) |
| `emergence/` | 自动归档、自动晋升、模式挖掘、技能编译 | [emergence/INDEX.md](./emergence/INDEX.md) |
| `oracle/` | fitness、ledger、调参器、元进化 | [oracle/INDEX.md](./oracle/INDEX.md) |
| `learners/` | 学习器运行时、hook gate、技能路由、prompt 片段 | [learners/INDEX.md](./learners/INDEX.md) |

## 阅读建议

- 想理解“怎么跑 shadow/arena”：先看 `arena/`
- 想理解“怎么从数据中长出规则/技能”：再看 `emergence/`
- 想理解“如何评估与调参”：再看 `oracle/`

## 关联模块

- 服务总览： [../INDEX.md](../INDEX.md)
- 任务/技能： [../../tasks/INDEX.md](../../tasks/INDEX.md)、[../../skills/INDEX.md](../../skills/INDEX.md)
- 根目录设计文档： [../../../docs/INDEX.md](../../../docs/INDEX.md)
