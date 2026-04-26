/**
 * Dream Pipeline 开关 —— Phase D 最小补丁后:
 *
 *   CLAUDE_DREAM_PIPELINE         默认 ON  (=0/false opt-out)  总开关
 *   CLAUDE_DREAM_PIPELINE_SHADOW  默认 ON  (=0/false 放行切流)  影子闸门
 *   CLAUDE_DREAM_PIPELINE_MICRO   默认 ON  (=0/false opt-out)  micro 档
 *
 * 默认组合效果 = "静默观测":
 *   journal/triage/feedback 全部运转、/memory-map 能看到真实数据，
 *   但 shadow=ON 让 dispatchDream 始终返回 action=legacy,不改变
 *   autoDream 已有的时间/会话双闸逻辑。
 *
 * 打开真实切流只需 `CLAUDE_DREAM_PIPELINE_SHADOW=0`,其余默认保持即可。
 */

function envDisabled(name: string): boolean {
  const v = process.env[name]
  return v === '0' || v === 'false'
}

/** 总开关：默认 ON,`CLAUDE_DREAM_PIPELINE=0` 关掉 evidence 采集 + triage */
export function isDreamPipelineEnabled(): boolean {
  return !envDisabled('CLAUDE_DREAM_PIPELINE')
}

/** 影子闸门：默认 ON,仅当显式 `CLAUDE_DREAM_PIPELINE_SHADOW=0` 才放行切流 */
export function isDreamPipelineShadow(): boolean {
  return !envDisabled('CLAUDE_DREAM_PIPELINE_SHADOW')
}

/** micro 档位：默认 ON,但被 shadow 包住时不会真的跑 */
export function isDreamMicroEnabled(): boolean {
  return !envDisabled('CLAUDE_DREAM_PIPELINE_MICRO')
}
