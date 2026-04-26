/**
 * ndjsonLedger — Phase 12
 *
 * 职责(通用 ndjson 写入 + 轮换工具):
 *   - `appendJsonLine(path, obj)` 替代三处裸 `appendFileSync(...JSON.stringify+\n)`:
 *       · promotionFsm.recordTransition       → promotions.ndjson
 *       · sessionOrganismLedger.recordSessionOrganismLink → session-organisms.ndjson
 *       · fitnessOracle.scoreAgainstDimensions → fitness.ndjson
 *   - 写前检查文件大小,超过 MAX_LEDGER_BYTES 就先做轮换:
 *       foo.ndjson.(N-1) → foo.ndjson.N  (N 超过 MAX_ROTATED_FILES 时删除最老)
 *       foo.ndjson     → foo.ndjson.1
 *     再新建空主文件 append。
 *
 * 复用纪律(与 Phase 1-11 一致):
 *   - 失败静默 + logForDebugging,不抛给主流程
 *   - 原子化:rotate 使用 fs.renameSync(同目录 rename 是 POSIX 原子)
 *   - 纯工具:不引用 Phase 高层类型,能给任何 ndjson 文件用
 *   - 读端不变:readRecentTransitions / recentFitnessScores /
 *     readSessionOrganismLinks / archiveRetrospective 继续读主文件,
 *     轮换出的 .1/.2/.3 是冷归档,不参与查询(未来需要再做 Phase 14 合并读)
 *
 * 安全闸门:
 *   - rotate 失败不阻塞 append:降级为"直接 append"继续工作,文件会超阈值
 *     但不丢行(日志会警告 + 下一次 append 再次尝试 rotate)
 *   - opts.maxBytes / opts.maxRotations 可选覆盖,供测试与运维场景临时调整
 *   - 写锁:Node 单进程内 appendFileSync + renameSync 都是同步系统调用,
 *     多线程进程里需更强锁机制,但 Claude Code 今天是单线程 I/O 事件循环,
 *     不需要额外锁
 */

import {
  appendFileSync,
  existsSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { logForDebugging } from '../../../utils/debug.js'
import { ensureDir } from '../paths.js'

/** 主文件超过这个字节数即触发轮换(10 MB) */
export const MAX_LEDGER_BYTES = 10 * 1024 * 1024

/** 最多保留几个历史轮换文件(.1 ~ .N);超过的最老一个被删除 */
export const MAX_ROTATED_FILES = 3

/** 运行时可覆盖的轮换参数(便于测试 + /evolve-tick 运维) */
export interface RotationOptions {
  /** 覆盖默认 MAX_LEDGER_BYTES */
  maxBytes?: number
  /** 覆盖默认 MAX_ROTATED_FILES */
  maxRotations?: number
}

/**
 * 读主文件字节数,异常返回 -1(视为"不存在,不需要轮换")。
 */
function fileBytes(path: string): number {
  try {
    if (!existsSync(path)) return -1
    return statSync(path).size
  } catch {
    return -1
  }
}

/**
 * 纯副作用:把 path 轮换一层,基于当前 maxRotations。
 *   - 删 foo.ndjson.{maxRotations}(最老,超期冷归档)
 *   - rename foo.ndjson.{i} → foo.ndjson.{i+1}  for i = maxRotations-1 .. 1
 *   - rename foo.ndjson → foo.ndjson.1
 *   - 写入空的新 foo.ndjson(用 writeFileSync('')原子覆盖,避免 append 时
 *     文件不存在而打乱 mtime 语义)
 *
 * 失败静默,返回 true/false。调用方依据返回值决定是否继续 append。
 */
function rotateNdjson(path: string, maxRotations: number): boolean {
  try {
    ensureDir(dirname(path))
    // 1) 删最老(若存在)
    const oldestPath = `${path}.${maxRotations}`
    if (existsSync(oldestPath)) {
      try {
        unlinkSync(oldestPath)
      } catch (e) {
        logForDebugging(
          `[ndjsonLedger] drop oldest failed ${oldestPath}: ${(e as Error).message}`,
        )
        // 继续 — 删除失败最多是磁盘占用多一点,不影响 rotation 正确性
      }
    }
    // 2) 往下挪(maxRotations-1 → maxRotations,... 1 → 2)
    for (let i = maxRotations - 1; i >= 1; i--) {
      const src = `${path}.${i}`
      const dst = `${path}.${i + 1}`
      if (existsSync(src)) {
        try {
          renameSync(src, dst)
        } catch (e) {
          logForDebugging(
            `[ndjsonLedger] shift failed ${src}→${dst}: ${(e as Error).message}`,
          )
          // 遇到 shift 失败就停止,保持已有次序;后续 append 会再试
          return false
        }
      }
    }
    // 3) 主文件 → .1
    if (existsSync(path)) {
      try {
        renameSync(path, `${path}.1`)
      } catch (e) {
        logForDebugging(
          `[ndjsonLedger] rotate main→.1 failed ${path}: ${(e as Error).message}`,
        )
        return false
      }
    }
    // 4) 新建空主文件
    try {
      writeFileSync(path, '', 'utf-8')
    } catch (e) {
      logForDebugging(
        `[ndjsonLedger] init new main failed ${path}: ${(e as Error).message}`,
      )
      // 这里失败通常意味着目录权限坏,后续 appendFileSync 也会失败 — 返回 false
      return false
    }
    return true
  } catch (e) {
    logForDebugging(
      `[ndjsonLedger] rotate failed ${path}: ${(e as Error).message}`,
    )
    return false
  }
}

/**
 * 大小到阈值就轮换。独立导出方便 /evolve-tick 主动调用做运维。
 * 不到阈值返回 false(没做事),到阈值并成功返回 true。
 */
export function rotateIfNeeded(
  path: string,
  opts?: RotationOptions,
): { rotated: boolean; bytesBefore: number; maxBytes: number } {
  const maxBytes = opts?.maxBytes ?? MAX_LEDGER_BYTES
  const maxRotations = opts?.maxRotations ?? MAX_ROTATED_FILES
  const bytes = fileBytes(path)
  if (bytes < 0 || bytes <= maxBytes) {
    return { rotated: false, bytesBefore: bytes, maxBytes }
  }
  const ok = rotateNdjson(path, maxRotations)
  return { rotated: ok, bytesBefore: bytes, maxBytes }
}

/**
 * Append 一行 JSON 到 ndjson 文件。
 *   - 写前先检查并轮换(如需)
 *   - JSON.stringify(obj) + '\n' 是当前所有 ledger 的统一行格式
 *   - 失败静默返回 false
 *
 * 该函数替代原先 3 处裸 appendFileSync —— 行为完全向后兼容,
 * 额外赋予"自动轮换"能力,现有读端不感知。
 */
export function appendJsonLine(
  path: string,
  obj: unknown,
  opts?: RotationOptions,
): boolean {
  try {
    // 1) 轮换(如需)。失败降级为"直接 append",不阻塞写路径。
    rotateIfNeeded(path, opts)
    // 2) 确保目录存在(首次写场景)
    ensureDir(dirname(path))
    // 3) append
    appendFileSync(path, JSON.stringify(obj) + '\n', 'utf-8')
    return true
  } catch (e) {
    logForDebugging(
      `[ndjsonLedger] appendJsonLine failed ${path}: ${(e as Error).message}`,
    )
    return false
  }
}
