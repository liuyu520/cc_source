/**
 * autoEvolve / learners / hookGate —— 学习每个 hook 在当前会话风格下是否值得 gate。
 *
 * 问题:
 *   autoEvolve Phase 14 把晋升到 stable 的 organism 的 hook.sh 拷贝到
 *   ~/.claude/autoEvolve/installed-hooks/<id>/ 并排队 install event。reviewer 把
 *   它粘进 settings.json 之后,这个 hook 就一直触发 —— 但是否"该触发"没有学习:
 *     - 某 hook 在 90% 情况下 fire 后用户立刻 rollback → 其实该关掉
 *     - 某 hook 在 90% 情况下 fire 后用户继续推进 → 是好 hook,该保留
 *   这份信号如果不反馈给任何地方,就永远无法收敛。
 *
 * 本 learner 维护"每个 hook 的 gateWeight ∈ [0,1]",作为运行时软门:
 *   - 未来某个 hook dispatcher 在真正触发前可以读 learner,
 *     按 gateWeight 做 ε-greedy 采样:以 gateWeight 的概率放行,否则跳过。
 *   - gateWeight 的 update 规则:
 *       fire 后该 turn 标为 'win'    → gateWeight += α          (鼓励)
 *       fire 后该 turn 标为 'loss'   → gateWeight -= α          (惩罚)
 *       fire 后该 turn 标为 'neutral'→ gateWeight 向 0.5 微收敛  (探索保持)
 *   - 初始(未记录过)gateWeight = 0.8(偏向保守放行,避免冷启动就关)。
 *
 * 与 autoEvolve 既有信号源的对接(本 PR 不改消费侧,只预留 API):
 *   - arena/shadowRunner 已经有 "hook fired → session outcome" 的 session-organism 关联
 *   - rollbackWatchdog 触发时,recordOutcome('hook-gate', { hookName, turnOutcome:'loss' })
 *     可以由 watchdog 直接调用。
 *   - 调用侧可参考 recordDreamOutcome 的写法:
 *       await recordOutcome('hook-gate', { hookName: 'pre-bash-guard', fired: true, turnOutcome: 'loss' })
 *
 * 设计选择:
 *   - 不存"从未见过的 hook":hookGates 是稀疏 map,只记录 recordOutcome 过的 hook
 *   - getHookGateWeight(name) 缺失时返回 DEFAULT_GATE_WEIGHT(0.8),让新 hook 冷启动合理
 *   - 单个 hook 的 gateWeight 独立更新,不 normalize(hooks 不是互斥权重)
 */

import type { Learner } from '../types.js'
import { clamp, makeJsonLoader, makeJsonSaver, roundTo } from './shared.js'

// ── 类型 ──────────────────────────────────────────────────────────────
export interface HookGateParams {
  /**
   * 每个 hook 的软门权重(∈ [0,1])。key = hook 名(如 'pre-bash-guard')。
   * 值越高 → 越倾向于放行该 hook。
   */
  hookGates: Record<string, number>
  updatedAt: string
}

export interface HookGateOutcome {
  /** 被触发的 hook 名(= 写 settings.json 里的 hook 标识) */
  hookName: string
  /** 本轮是否真的 fire 过(false 用于记录"gate 挡下来"的探索样本) */
  fired: boolean
  /** 该 turn 的 outcome —— win = 用户接受并继续;loss = 用户回滚/打断;neutral = 不明 */
  turnOutcome: 'win' | 'loss' | 'neutral'
}

// ── 常量 ──────────────────────────────────────────────────────────────

/** 初始默认 —— 空 map,运行时按需增长 */
export const DEFAULT_HOOK_GATE_PARAMS: HookGateParams = {
  hookGates: {},
  updatedAt: '1970-01-01T00:00:00.000Z',
}

/** 单个 hook 第一次出现时的 gateWeight 初值(偏向保守放行) */
export const DEFAULT_GATE_WEIGHT = 0.8

/** 学习率 α —— 与 dreamTriage 的 0.05 对齐,保守稳态 */
const LEARNING_RATE = 0.05

/** neutral 样本朝 0.5 微收敛的速率(探索保持) */
const NEUTRAL_PULL = 0.01

// ── update 核心 ───────────────────────────────────────────────────────

/**
 * 接受一条 outcome,返回更新后的 params。
 * 纯函数,便于测试。
 */
export function updateHookGateParams(
  current: HookGateParams,
  outcome: HookGateOutcome,
): HookGateParams {
  // fired=false 的样本只用于探索统计,不改权重(避免"没触发也被奖励"错位)。
  if (!outcome.fired) return current

  const next: HookGateParams = {
    hookGates: { ...current.hookGates },
    updatedAt: new Date().toISOString(),
  }

  const prev =
    typeof next.hookGates[outcome.hookName] === 'number'
      ? next.hookGates[outcome.hookName]
      : DEFAULT_GATE_WEIGHT

  let updated: number
  switch (outcome.turnOutcome) {
    case 'win':
      updated = prev + LEARNING_RATE
      break
    case 'loss':
      updated = prev - LEARNING_RATE
      break
    case 'neutral':
    default:
      // 向 0.5 微收敛:|prev - 0.5| 的方向减小
      updated = prev + (0.5 - prev) * NEUTRAL_PULL
      break
  }

  next.hookGates[outcome.hookName] = roundTo(clamp(updated, 0.02, 0.98), 3)
  return next
}

// ── Learner 实例 ──────────────────────────────────────────────────────

export const hookGateLearner: Learner<HookGateParams, HookGateOutcome> = {
  domain: 'hook-gate',
  defaults: DEFAULT_HOOK_GATE_PARAMS,
  load: makeJsonLoader<HookGateParams>(
    'hook-gate',
    DEFAULT_HOOK_GATE_PARAMS,
    parsed => {
      // migrate:老文件 hookGates 不存在时补空对象;每个值 clamp 防脏数据
      const gates = (parsed.hookGates ?? {}) as Record<string, unknown>
      const clean: Record<string, number> = {}
      for (const [name, v] of Object.entries(gates)) {
        if (typeof v === 'number' && Number.isFinite(v)) {
          clean[name] = clamp(v, 0.02, 0.98)
        }
      }
      return { hookGates: clean, updatedAt: parsed.updatedAt ?? new Date().toISOString() }
    },
  ),
  save: makeJsonSaver<HookGateParams>('hook-gate'),
  update: updateHookGateParams,
}

// ── 便捷读出口 ────────────────────────────────────────────────────────

/**
 * 同步读取当前某 hook 的 gateWeight。
 *
 * 注:本 helper 不走 learner registry 的 load(那是 async Map 查找),而是
 * 直接读 JSON,供 hook dispatcher 在热路径上调用。文件缺失/字段缺 → DEFAULT_GATE_WEIGHT。
 *
 * 调用成本:一次 fs.readFileSync;hook dispatcher 多为 per-tool 触发,可接受。
 * 若后续热路径压力大,可改为 mtime-cached(见 thresholdTuner 的做法)。
 */
export async function getHookGateWeight(hookName: string): Promise<number> {
  try {
    const params = await hookGateLearner.load()
    const w = params.hookGates[hookName]
    return typeof w === 'number' ? w : DEFAULT_GATE_WEIGHT
  } catch {
    return DEFAULT_GATE_WEIGHT
  }
}
