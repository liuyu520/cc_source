/**
 * autoEvolve — self-evolution-kernel v1.0 §5 Phase 5 · MetaGenome 存储层
 *
 * 定位:
 *   blueprint §2 支柱 VI(元进化)定义:fitness 权重、变异率、选择压力、
 *   arena 宽度都是"可进化基因"。本模块是这个元基因池的**最小持久化层**:
 *   只负责读/写/合并,不接任何既有 arena / shadow 判定路径。
 *
 * 与 oracle/metaEvolver.ts 的关系:
 *   metaEvolver 管"4 维 oracle 权重"(用户/任务/代码/性能),范围很窄,只在
 *   scoreSubject 读。本模块管**系统级元参数**(变异率、学习率、选择压力、
 *   arena 宽度),更宏观,将来由 metaOracle 基于种群健康度反馈驱动。
 *   两者各自独立的 JSON 快照,互不覆盖。
 *
 * 纪律:
 *   - 纯存储:只读/写/clamp;所有决策点继续读 DEFAULT_* 常量,不切换
 *     到 MetaGenome(那一步等 Phase 5.2 metaOracle 就绪后再做灰度)
 *   - fail-open:文件损坏/缺字段 → 默认值;不抛
 *   - env 优先级(遵循 feedback_signal_to_decision_priority_stack):
 *       explicit opts > env > file > default
 *   - mtime 缓存:与 tunedOracleWeights 对称
 *   - schema version = 1 预留给破坏性迁移
 *   - clamp 区间经过真实评估(见每个字段的注释),单维垄断/饿死都被顶住
 *
 * 安全护栏(blueprint §6.1):
 *   - Kill switch:无本模块专属开关,但既有 CLAUDE_EVOLVE=off 已覆盖
 *     所有 autoEvolve 路径;本模块即便被读取,只要没接入决策,也不产生
 *     副作用
 */

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { logForDebugging } from '../../../utils/debug.js'
import { ensureDir, getMetaDir, getMetaGenomePath } from '../paths.js'

/**
 * 元基因快照。version=1 预留给未来破坏性迁移。
 *
 * 字段语义:
 *   - mutationRate ∈ [0, 1]:shadow 诞生率系数,0 = 完全冻结,1 = 全量
 *     涌现。Pattern Miner 的 emit 速率最终会乘这个系数(Phase 5.3 接线)。
 *   - learningRate ∈ [0.001, 1]:feedbackLoop ε-greedy 步长。越大越激进。
 *   - selectionPressure ∈ [0.25, 4]:canary→stable 晋升阈值的倍率。
 *     >1 变严(更难晋升),<1 变松。默认 1.0 等价于现有行为。
 *   - arenaShadowCount ∈ [0, 8]:Runtime Arena 同时 alive 的 shadow
 *     上限;0 相当于"只保留 stable",硬天花板 8 与 arenaController 的
 *     MAX_PARALLEL_ARENAS 对齐,防止超过既有资源边界。
 */
export interface MetaGenome {
  version: 1
  updatedAt: string
  mutationRate: number
  learningRate: number
  selectionPressure: number
  arenaShadowCount: number
}

// ── Clamp 边界 ─────────────────────────────────────────────────────────────
// 理由见 MetaGenome 字段注释。
export const MUTATION_RATE_MIN = 0
export const MUTATION_RATE_MAX = 1
export const LEARNING_RATE_MIN = 0.001
export const LEARNING_RATE_MAX = 1
export const SELECTION_PRESSURE_MIN = 0.25
export const SELECTION_PRESSURE_MAX = 4
export const ARENA_SHADOW_COUNT_MIN = 0
/** 与 arenaController.MAX_PARALLEL_ARENAS 对齐,硬天花板不可突破。 */
export const ARENA_SHADOW_COUNT_MAX = 8

// ── 默认值 ─────────────────────────────────────────────────────────────────
// 默认值对齐"现有行为":
//   - mutationRate 0.3:中等变异,与 Phase 47/48 emergence tick 观察到的
//     健康吞吐一致(既不过稀也不过密)
//   - learningRate 0.1:feedbackLoop ε-greedy 常见起点
//   - selectionPressure 1.0:对应现有晋升阈值,不额外加压
//   - arenaShadowCount 3:保守默认,低于硬天花板 8,够覆盖 Phase 44 多样
//     性要求同时不压榨 token 预算
export const DEFAULT_META_GENOME: MetaGenome = {
  version: 1,
  updatedAt: '1970-01-01T00:00:00.000Z',
  mutationRate: 0.3,
  learningRate: 0.1,
  selectionPressure: 1.0,
  arenaShadowCount: 3,
}

// ── Clamp 工具 ─────────────────────────────────────────────────────────────
function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo
  return Math.min(hi, Math.max(lo, v))
}

function clampInt(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo
  return Math.min(hi, Math.max(lo, Math.trunc(v)))
}

/** 对外复用:把任意 partial 合并到默认值并 clamp;不动输入。 */
export function sanitizeMetaGenome(partial: Partial<MetaGenome>): MetaGenome {
  return {
    version: 1,
    updatedAt: partial.updatedAt ?? DEFAULT_META_GENOME.updatedAt,
    mutationRate: clamp(
      partial.mutationRate ?? DEFAULT_META_GENOME.mutationRate,
      MUTATION_RATE_MIN,
      MUTATION_RATE_MAX,
    ),
    learningRate: clamp(
      partial.learningRate ?? DEFAULT_META_GENOME.learningRate,
      LEARNING_RATE_MIN,
      LEARNING_RATE_MAX,
    ),
    selectionPressure: clamp(
      partial.selectionPressure ?? DEFAULT_META_GENOME.selectionPressure,
      SELECTION_PRESSURE_MIN,
      SELECTION_PRESSURE_MAX,
    ),
    arenaShadowCount: clampInt(
      partial.arenaShadowCount ?? DEFAULT_META_GENOME.arenaShadowCount,
      ARENA_SHADOW_COUNT_MIN,
      ARENA_SHADOW_COUNT_MAX,
    ),
  }
}

// ── mtime cache(与 tunedOracleWeights 对称) ─────────────────────────────
let _cache: { mtimeMs: number; value: MetaGenome } | null = null
function invalidateCache(): void {
  _cache = null
}

/**
 * 读当前持久化的 MetaGenome。
 * 文件缺失 → 返回 null(调用方应叠加 env + default,见 getEffectiveMetaGenome)。
 * 文件存在但字段缺/损 → 缺字段回退 DEFAULT,不整体丢弃。
 */
export function loadMetaGenome(): MetaGenome | null {
  try {
    const p = getMetaGenomePath()
    if (!existsSync(p)) {
      _cache = null
      return null
    }
    const stat = statSync(p)
    if (_cache && _cache.mtimeMs === stat.mtimeMs) {
      return _cache.value
    }
    const raw = readFileSync(p, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<MetaGenome>
    const value = sanitizeMetaGenome(parsed)
    _cache = { mtimeMs: stat.mtimeMs, value }
    return value
  } catch (e) {
    logForDebugging(
      `[autoEvolve:metaGenome] loadMetaGenome failed: ${(e as Error).message}`,
    )
    return null
  }
}

/**
 * 写盘(唯一写入口,未来 /evolve-meta 或 metaOracle 都走这里)。
 * 原子写:先写 *.tmp,再 rename(与 phylogenyWriter 一致,防半截文件)。
 */
export function saveMetaGenome(
  next: Partial<MetaGenome>,
): { ok: boolean; path: string; error?: string; value?: MetaGenome } {
  const path = getMetaGenomePath()
  try {
    ensureDir(getMetaDir())
    const sanitized = sanitizeMetaGenome({
      ...next,
      updatedAt: next.updatedAt ?? new Date().toISOString(),
    })
    const tmp = path + '.tmp'
    writeFileSync(tmp, JSON.stringify(sanitized, null, 2), 'utf-8')
    // rename 必须用 node:fs 同步版本,保持与 writeFileSync 同一执行路径
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { renameSync } = require('node:fs')
    renameSync(tmp, path)
    invalidateCache()
    return { ok: true, path, value: sanitized }
  } catch (e) {
    return { ok: false, path, error: (e as Error).message }
  }
}

// ── Env override(遵循 feedback_signal_to_decision_priority_stack) ──────────
// 识别环境变量并 clamp。非法或缺省 → undefined。
function readEnvNumber(key: string): number | undefined {
  const raw = process.env[key]
  if (raw === undefined || raw === '') return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

function collectEnvOverride(): Partial<MetaGenome> {
  const out: Partial<MetaGenome> = {}
  const mr = readEnvNumber('CLAUDE_EVOLVE_META_MUTATION_RATE')
  const lr = readEnvNumber('CLAUDE_EVOLVE_META_LEARNING_RATE')
  const sp = readEnvNumber('CLAUDE_EVOLVE_META_SELECTION_PRESSURE')
  const ac = readEnvNumber('CLAUDE_EVOLVE_META_ARENA_SHADOW_COUNT')
  if (mr !== undefined) out.mutationRate = mr
  if (lr !== undefined) out.learningRate = lr
  if (sp !== undefined) out.selectionPressure = sp
  if (ac !== undefined) out.arenaShadowCount = ac
  return out
}

/**
 * 优先级栈(遵循 feedback_signal_to_decision_priority_stack):
 *   explicit opts > env > file > default
 *
 * 使用场景:任何决策点想读"当前实际生效的元基因",只该走这个 API。
 * fail-open:永远返回合法结构,不抛。
 */
export interface GetEffectiveMetaGenomeOptions {
  explicit?: Partial<MetaGenome>
  skipEnv?: boolean
  skipFile?: boolean
}

export function getEffectiveMetaGenome(
  opts: GetEffectiveMetaGenomeOptions = {},
): MetaGenome {
  try {
    const fromFile = opts.skipFile ? null : loadMetaGenome()
    const fromEnv = opts.skipEnv ? {} : collectEnvOverride()
    const explicit = opts.explicit ?? {}
    // 按优先级从低到高合并:default < file < env < explicit
    const merged: Partial<MetaGenome> = {
      ...DEFAULT_META_GENOME,
      ...(fromFile ?? {}),
      ...fromEnv,
      ...explicit,
    }
    return sanitizeMetaGenome(merged)
  } catch (e) {
    logForDebugging(
      `[autoEvolve:metaGenome] getEffectiveMetaGenome fail-open: ${(e as Error).message}`,
    )
    return { ...DEFAULT_META_GENOME }
  }
}

/** 测试专用:重置内部缓存。 */
export function _resetMetaGenomeCacheForTest(): void {
  invalidateCache()
}
