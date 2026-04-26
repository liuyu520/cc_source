/**
 * jobs/classifier — 任务复杂度分类器
 *
 * 历史:原为 3 行 stub (runClassifier() => null),被 feature('TEMPLATES')
 * gated 引用,未激活。
 *
 * 本次升级(Q0,2026-04-25)填实内容:
 *   - 保留原 `runClassifier()` 导出(TEMPLATES gate 路径),确保 preserve logic
 *   - 新增 `classifyTaskComplexity(text)` 纯同步函数,用于 ModelRouter
 *     B 线(routeContextSignals.ts)派生 RouteContext.taskComplexity 信号
 *
 * 分类语义(对齐 modelRouter/types.ts TaskComplexity):
 *   - trivial:  短查询/命令,如 "ls" / "pwd" / "echo x"
 *   - simple:   typo / rename / 加 log / 单文件单点改动
 *   - moderate: 中等体量(~200 字符)或含多步骤提示词
 *   - hard:     架构/重构/迁移/并发/设计类;或超长 + 多步
 *
 * 设计约束:
 *   - 纯同步,无 IO
 *   - 失败回 'simple'(最常见中档,避免 router 误判到极端)
 *   - 不引入新依赖,只用正则
 */

import type { TaskComplexity } from '../services/modelRouter/types.js'

/** trivial 命令模式(单词开头 + 短文本) */
const TRIVIAL_PREFIX = /^\s*(ls|pwd|whoami|echo|cat|head|tail|status|version|help|which|date|clear|cd)\b/i

/** simple 意图模式(典型单点改动) */
const SIMPLE_PATTERNS: RegExp[] = [
  /(fix|修|改)\s+(typo|错别字|错字)/i,
  /(add|加|添加)\s+(a\s+)?(log|comment|注释|打印|print)/i,
  /(rename|重命名|改名)\s+/i,
  /(格式化|format)\s+/i,
]

/** hard 关键词(架构/重构/迁移等重型任务) */
const HARD_KEYWORDS: readonly string[] = [
  'architecture',
  '架构',
  'refactor',
  '重构',
  'migrate',
  '迁移',
  'migration',
  'distributed',
  '分布式',
  'concurrent',
  '并发',
  'concurrency',
  'pipeline',
  'optimize',
  '优化性能',
  'schema design',
  'design pattern',
  '设计模式',
  'system design',
]

/** 多步骤连词(提示词里出现 ≥1 个通常代表 composite 任务) */
const MULTI_STEP_TOKENS: readonly string[] = [
  'step 1',
  'step 2',
  'first...then',
  'then',
  'after that',
  'finally',
  '然后',
  '接着',
  '之后',
  '最后',
  '先 ',
  '再 ',
]

function containsAny(haystack: string, needles: readonly string[]): boolean {
  for (const n of needles) {
    if (haystack.includes(n.toLowerCase())) return true
  }
  return false
}

/**
 * 分类入口。fail-safe:空输入/异常均返回 'simple'。
 */
export function classifyTaskComplexity(
  text: string | undefined | null,
): TaskComplexity {
  try {
    if (!text) return 'simple'
    const normalized = text.trim()
    if (!normalized) return 'simple'
    const lower = normalized.toLowerCase()
    const len = normalized.length

    // 1. trivial:短 + 命令前缀
    if (len <= 40 && TRIVIAL_PREFIX.test(normalized)) return 'trivial'

    // 2. hard:强关键词直接命中
    if (containsAny(lower, HARD_KEYWORDS)) return 'hard'

    // 3. hard:超长 + 多步(>400 字符 + 多步连词)
    const hasMultiStep = containsAny(lower, MULTI_STEP_TOKENS)
    if (len > 400 && hasMultiStep) return 'hard'

    // 4. moderate:中长 或 含多步
    if (len > 200 || hasMultiStep) return 'moderate'

    // 5. simple:常见单点改动模式
    for (const pat of SIMPLE_PATTERNS) {
      if (pat.test(normalized)) return 'simple'
    }

    // 6. 默认阈值:< 80 → simple;80-200 → moderate
    return len > 80 ? 'moderate' : 'simple'
  } catch {
    return 'simple'
  }
}

/**
 * 原有 stub 接口,保留以兼容 feature('TEMPLATES') gate 的 require 路径。
 * 目前调用方(stopHooks.ts / query.ts)仅在 TEMPLATES 开启时引用,本函数
 * 保留 null 返回以防意外行为变更。
 */
export async function runClassifier() {
  return null
}
