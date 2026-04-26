/**
 * self-evolution-kernel v1.0 §6.1 Lock #5 — Oracle Signing 消费端
 *
 * 背景:fitnessOracle.sign() 与 promotionFsm.signTransition() 一直在
 * 写入侧生成 sha256 签名,但既有代码路径从未在"读取侧"重算并比对。
 * 本模块补齐闭环:给消费者(/evolve-status、autoPromotionEngine、
 * 任何审计工具)一个统一、只读的 verifyXxx/auditLedgerIntegrity 入口,
 * 直接沿用既有的签名算法(computeFitnessSignature / signTransition),
 * 绝不重新实现算法 —— 避免"两套哈希漂移"。
 *
 * 设计铁律:
 *   - 纯读,绝不写盘、绝不修改任何 ledger
 *   - 失败静默 + logForDebugging,消费端拿到零值即可(fail-open 理念
 *     与 ContextSignalSource / toolResultRefinery 一致)
 *   - 不抛异常给调用链,避免把一条坏 ledger 行演变成 promote 崩溃
 *   - 不做自动"修复",发现篡改只暴露给人看,修复永远是人工决定
 */

import { existsSync, readFileSync } from 'node:fs'

import { logForDebugging } from '../../../utils/debug.js'
import {
  getFitnessLedgerPath,
  getPromotionLedgerPath,
} from '../paths.js'
import type { FitnessScore, Transition } from '../types.js'
import { signTransition } from '../arena/promotionFsm.js'
import { computeFitnessSignature } from './fitnessOracle.js'

// ── 单条校验 ────────────────────────────────────────────────

/**
 * 单条 Transition 签名校验:重算 sha256,与 ledger 里的 signature 字段比对。
 * - 缺字段 / 缺 signature → 返回 false(视为"未签名")
 */
export function verifyTransitionSignature(t: Transition): boolean {
  if (!t || typeof t !== 'object') return false
  if (typeof t.signature !== 'string' || t.signature.length === 0) return false
  try {
    const expected = signTransition({
      organismId: t.organismId,
      from: t.from,
      to: t.to,
      trigger: t.trigger,
      rationale: t.rationale,
      at: t.at,
      oracleScoreSignature: t.oracleScoreSignature,
    })
    return expected === t.signature
  } catch {
    return false
  }
}

/**
 * 单条 FitnessScore 签名校验:复用 computeFitnessSignature。
 * - 缺字段 / 缺 signature → 返回 false
 */
export function verifyFitnessScoreSignature(s: FitnessScore): boolean {
  if (!s || typeof s !== 'object') return false
  if (typeof s.signature !== 'string' || s.signature.length === 0) return false
  try {
    const expected = computeFitnessSignature(s.score, s.dimensions, s.scoredAt)
    return expected === s.signature
  } catch {
    return false
  }
}

// ── Ledger 完整性审计 ──────────────────────────────────────

export interface LedgerIntegrityReport {
  /** 被扫描的 ledger 路径(若不存在,reported=0) */
  path: string
  /** ledger 是否存在 */
  exists: boolean
  /** 总行数(跳过空行) */
  total: number
  /** 通过签名校验的行数 */
  verified: number
  /** 签名不匹配的行数(真正的"篡改") */
  tampered: number
  /** 未带 signature 字段的行数(历史遗留/未签名,非篡改) */
  unsigned: number
  /** JSON 解析失败的坏行数 */
  malformed: number
  /** 采样的前几条篡改行摘要,用于 /evolve-status 展示 */
  tamperedSamples: Array<{ line: number; id: string }>
}

interface VerifyOneFn<T> {
  (x: T): boolean
}

function auditNdjsonLedger<T>(
  path: string,
  verifyOne: VerifyOneFn<T>,
  idOf: (x: T) => string,
  maxSamples = 3,
): LedgerIntegrityReport {
  const base: LedgerIntegrityReport = {
    path,
    exists: false,
    total: 0,
    verified: 0,
    tampered: 0,
    unsigned: 0,
    malformed: 0,
    tamperedSamples: [],
  }
  try {
    if (!existsSync(path)) return base
    base.exists = true
    const raw = readFileSync(path, 'utf-8')
    const lines = raw.split('\n').filter(l => l.trim().length > 0)
    base.total = lines.length
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        base.malformed++
        continue
      }
      const row = parsed as Record<string, unknown>
      // unsigned: 没 signature 字段,视为历史遗留
      if (
        typeof row.signature !== 'string' ||
        (row.signature as string).length === 0
      ) {
        base.unsigned++
        continue
      }
      try {
        if (verifyOne(row as unknown as T)) {
          base.verified++
        } else {
          base.tampered++
          if (base.tamperedSamples.length < maxSamples) {
            base.tamperedSamples.push({
              line: i + 1,
              id: idOf(row as unknown as T) || '<unknown>',
            })
          }
        }
      } catch (e) {
        // verifyOne 内部抛不会发生(都裹了 try),兜底
        base.malformed++
        logForDebugging(
          `[signatureVerifier] verify row ${i + 1} threw: ${(e as Error).message}`,
        )
      }
    }
    return base
  } catch (e) {
    logForDebugging(
      `[signatureVerifier] audit ${path} failed: ${(e as Error).message}`,
    )
    return base
  }
}

/** 扫描 promotions.ndjson,返回完整性报告。纯只读。 */
export function auditPromotionLedger(): LedgerIntegrityReport {
  return auditNdjsonLedger<Transition>(
    getPromotionLedgerPath(),
    verifyTransitionSignature,
    t => `${t.organismId}:${t.from}→${t.to}`,
  )
}

/** 扫描 fitness.ndjson,返回完整性报告。纯只读。 */
export function auditFitnessLedger(): LedgerIntegrityReport {
  return auditNdjsonLedger<FitnessScore>(
    getFitnessLedgerPath(),
    verifyFitnessScoreSignature,
    s => s.organismId ?? s.subjectId ?? '<unknown>',
  )
}

/** 组合视图:便于 /evolve-status 一次性拉两条 ledger 的摘要。 */
export interface IntegrityDigest {
  promotions: LedgerIntegrityReport
  fitness: LedgerIntegrityReport
  /** 是否存在任何 tampered(供上层快速 boolean 判断) */
  hasTampering: boolean
}

export function digestLedgerIntegrity(): IntegrityDigest {
  const promotions = auditPromotionLedger()
  const fitness = auditFitnessLedger()
  return {
    promotions,
    fitness,
    hasTampering: promotions.tampered > 0 || fitness.tampered > 0,
  }
}
