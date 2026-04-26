# `src/services/skillSearch/` 模块索引

## 模块定位

`src/services/skillSearch/` 负责技能召回与发现，包括意图分类、上下文加权、本地索引、远程 skill 加载、信号提取、同义词扩展与召回遥测。

## 关键文件

- `localSearch.ts`
  本地技能索引与召回主入口
- `intentRouter.ts`
  意图分类、融合权重与压制策略
- `contextScoring.ts`
  上下文得分
- `prefetch.ts`
  预取逻辑
- `signals.ts`
  发现信号模型

## 其他文件

- `featureCheck.ts`
- `discoveredState.ts`
- `remoteSkillLoader.ts`
- `remoteSkillState.ts`
- `skillWorkflows.ts`
- `synonyms.ts`
- `tokenizer.ts`
- `telemetry.ts`
- `workflowTracker.ts`

## 设计关注点

- 这里不是简单搜索，而是“意图 + 词法 + 上下文 + heat/prior”的融合召回
- 和 `commands.ts`、`skills/loadSkillsDir.ts`、MCP skill、actionRegistry 有交叉

## 关联模块

- 技能系统： [../../skills/INDEX.md](../../skills/INDEX.md)
- 服务总览： [../INDEX.md](../INDEX.md)
