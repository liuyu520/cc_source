/**
 * autoEvolve / learners / shared —— 所有 built-in learner 共享的 JSON I/O 模板。
 *
 * 背景:
 *   autoDream/feedbackLoop.ts 的 dreamTriageLearner 里把 load/save 与 ε-greedy
 *   update 混在一起。P0 要补齐 hook-gate / skill-route / prompt-snippet /
 *   auto-continue 四个 learner —— 如果每个都重写一遍"mkdir + readFile + JSON.parse
 *   + writeFile",就会出现 4 份几乎一样的样板代码。
 *
 * 本模块抽出两件事:
 *   1. makeJsonLoader<P>(domain, defaults, migrate?) — load 的通用实现
 *      - 文件缺失/损坏  → 返回 {...defaults}
 *      - 文件存在但字段缺 → 缺字段回填 defaults(向后兼容"老 json + 新字段")
 *      - 可选 migrate:    在 parsed 之上进一步清洗(clamp / 删除废弃字段等)
 *   2. makeJsonSaver<P>(domain) — save 的通用实现
 *      - 透过 paths.getLearnerParamsPath(domain) 落盘
 *      - 自动 mkdir(幂等)
 *      - 写入失败静默 —— 与 dreamTriage 保持一致的"软信号,不影响主流程"语义
 *
 * 设计选择:
 *   - 路径统一走 paths.getLearnerParamsPath,与 types.ts §7 及 v1.0 文档
 *     `~/.claude/autoEvolve/learners/<domain>.json` 对齐
 *   - 所有 Params 必须是"可 JSON 序列化的扁平对象";嵌套/环形不做支持
 *     (学习器参数天然扁平,不值得复杂化)
 *   - 不在这里做 updateWeights 抽象:ε-greedy 的归一化策略各 learner 不同
 *     (dream-triage 的总和=1.2 vs hook-gate 的单点 [0,1]),抽象反而失真
 *   - 所有失败都吞:autoEvolve/index.ts recordOutcome 本身已有 try/catch,
 *     这里再吞一层是防守式设计,debug 日志仍会打出错误原因
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { logForDebugging } from '../../../utils/debug.js'
import { getLearnerParamsPath } from '../paths.js'

/**
 * 构造一个符合 Learner.load 签名的 loader。
 *
 * @param domain    Learner.domain,也是 JSON 文件名 slug
 * @param defaults  缺文件或缺字段时的回退
 * @param migrate   可选;parsed 后再做一遍清洗(例如 clamp),返回新 Params
 */
export function makeJsonLoader<P extends Record<string, unknown>>(
  domain: string,
  defaults: P,
  migrate?: (parsed: P) => P,
): () => Promise<P> {
  return async () => {
    try {
      const path = getLearnerParamsPath(domain)
      if (!existsSync(path)) return { ...defaults }
      const raw = readFileSync(path, 'utf-8')
      const parsed = JSON.parse(raw) as Partial<P>
      // 向后兼容:缺字段回填 defaults
      const merged = { ...defaults, ...parsed } as P
      return migrate ? migrate(merged) : merged
    } catch (e) {
      // 损坏/权限 → 回默认。不抛给上层,autoEvolve 的 learner 是"软信号"。
      logForDebugging(
        `[learners/${domain}] load failed, returning defaults: ${(e as Error).message}`,
      )
      return { ...defaults }
    }
  }
}

/**
 * 构造一个符合 Learner.save 签名的 saver。
 *
 * @param domain  Learner.domain,也是 JSON 文件名 slug
 */
export function makeJsonSaver<P>(
  domain: string,
): (params: P) => Promise<void> {
  return async params => {
    try {
      const path = getLearnerParamsPath(domain)
      const dir = dirname(path)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(path, JSON.stringify(params, null, 2), 'utf-8')
    } catch (e) {
      // 写失败只打 debug,不抛 —— 与 dreamTriage 保持一致。
      logForDebugging(
        `[learners/${domain}] save failed: ${(e as Error).message}`,
      )
    }
  }
}

/**
 * clamp 工具:把值夹到 [min, max]。learner 们的权重更新后普遍要 clamp,
 * 放这里免得四处复制。
 */
export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  if (value < min) return min
  if (value > max) return max
  return value
}

/**
 * 把四舍五入到 N 位小数的操作抽出来。所有 learner 落盘前都建议 round,
 * 避免浮点脏尾占满 JSON。
 */
export function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}
