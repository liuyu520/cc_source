# `src/memdir/` 模块索引

## 模块定位

`src/memdir/` 是仓库内“记忆目录”与记忆提示系统的核心实现，负责记忆扫描、筛选、知识图谱、向量索引、生命周期和写入质量门控。

## 关键文件

- `memdir.ts`
  记忆目录与 prompt 侧主入口
- `findRelevantMemories.ts`
  检索当前上下文最相关记忆
- `knowledgeGraph.ts`
  记忆关系图谱
- `vectorIndex.ts`
  向量索引
- `memoryLifecycle.ts`
  记忆生命周期管理
- `writeQualityGate.ts`
  写入质量门控

## 其他文件

- `autoDistill.ts`
  记忆蒸馏/抽取
- `memoryPostToolHook.ts`
  工具调用后记忆处理
- `memoryScan.ts`
  记忆扫描
- `memoryShapeTelemetry.ts`
  记忆形态指标
- `teamMemPaths.ts`、`teamMemPrompts.ts`
  团队记忆路径与提示

## 运行关系

- 系统提示词在 `src/constants/prompts.ts` 中会调用这里的记忆加载逻辑
- 服务层的 session/memory 管线会与这里协同决定哪些记忆进入对话上下文

## 关联模块

- 服务层： [../services/INDEX.md](../services/INDEX.md)
- 常量与系统提示： [../constants/INDEX.md](../constants/INDEX.md)
- 根级知识文档： [../../docs/INDEX.md](../../docs/INDEX.md)
