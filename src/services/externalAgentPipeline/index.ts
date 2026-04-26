/**
 * externalAgentPipeline 公共 API 聚合
 *
 * 暴露 runPipeline 及历史查询函数,供脚本/kernel-status 使用。
 */

export {
  clearPipelineHistory,
  getPipelineHistory,
  runPipeline,
  type PipelineAgent,
  type PipelineRun,
  type PipelineSpec,
  type PipelineStageContext,
  type PipelineStageSpec,
  type StageResult,
} from './runner.js'
