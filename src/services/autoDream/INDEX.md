# `src/services/autoDream/` 模块索引

## 模块定位

`src/services/autoDream/` 负责后台记忆整合与 dream pipeline，在满足时间/会话门槛时触发 consolidation、micro dream 或完整 dream 流程。

## 关键文件

- `autoDream.ts`
  主流程，包含 gate、legacy 路径与 pipeline 切流
- `config.ts`
  配置与开关
- `consolidationLock.ts`
  并发锁与会话扫描
- `consolidationPrompt.ts`
  consolidation prompt

## `pipeline/` 子目录

- `index.ts`
- `featureCheck.ts`
- `triage.ts`
- `microDream.ts`
- `feedbackLoop.ts`
- `sessionEpilogue.ts`
- `evidenceBus.ts`
- `journal.ts`
- `types.ts`

## 设计关注点

- 既包含 legacy full consolidation，也包含 pipeline 化的 triage/micro/full 路径
- 与 `memdir/`、`tasks/DreamTask/`、`analytics/` 和后台 housekeeping 紧密协作

## 关联模块

- 记忆系统： [../../memdir/INDEX.md](../../memdir/INDEX.md)
- 任务系统： [../../tasks/INDEX.md](../../tasks/INDEX.md)
- 服务总览： [../INDEX.md](../INDEX.md)
