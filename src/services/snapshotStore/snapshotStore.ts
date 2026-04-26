/**
 * SnapshotStore —— 跨会话的"内存快照"落盘/回填的通用适配层。
 *
 * 背景:
 *   agentStats 目前依赖 episodicMemory 里 .jsonl 重算:冷启动需要扫盘 + 聚合,
 *   在 maxSamples 封顶后丢掉尾样本;toolStats 的 ring buffer 则纯内存,每次
 *   CLI 启动从零开始。长期工作流(自适应配额、preflight 熔断阈值)需要跨
 *   session 的历史感知,但又没有数据库可用。
 *
 * 解法:
 *   每个订阅方声明自己的 { namespace, getSnapshot, applySnapshot },由本模块
 *   负责 serialize → atomic write → read-on-boot → deserialize,并在进程级注
 *   册表里登记,供 /kernel-status 观察。
 *
 * 设计要点(举一反三自 preflight / rateBucket / autoContinue 的 factory+registry):
 *   1. 原子写入:写 .tmp 再 rename,崩溃永不留半文件
 *   2. 吞错:任何 fs 异常都不会抛出主路径 —— 落盘失败只是退化为"每次冷启动
 *      重算",绝不能影响主要功能
 *   3. 版本字段:schemaVersion 不一致 → 直接忽略旧文件(视同未持久化)
 *   4. 路径:<projectDir>/snapshots/<namespace>.json —— 与 episodes/ 对称
 *   5. 同一 namespace 重复注册 = 覆盖(热重载场景)
 */

import * as fs from 'fs'
import * as path from 'path'
import { logForDebugging } from '../../utils/debug.js'

// ── 类型 ──────────────────────────────────────────────────

export interface SnapshotStoreHandle<T> {
  readonly namespace: string
  readonly schemaVersion: number
  /** 把 getSnapshot() 当前返回值写盘。返回是否成功写入。 */
  saveNow(projectDir: string): Promise<boolean>
  /**
   * 从 <projectDir>/snapshots/<namespace>.json 读取并 applySnapshot。
   * - 文件不存在:返回 false,不触发 apply
   * - schemaVersion 不一致:返回 false,不触发 apply(旧数据视同被忽略)
   * - 解析失败:返回 false,并吞掉异常
   */
  loadNow(projectDir: string): Promise<boolean>
  /** 删除落盘文件。吞错。 */
  deleteNow(projectDir: string): Promise<boolean>
  /** 观测:最近一次成功 save 的时间戳。 */
  getLastSavedAt(): number | null
  /** 观测:最近一次成功 load 的时间戳。 */
  getLastLoadedAt(): number | null
  /** 观测:最近一次 save 产生的字节数(估算)。 */
  getLastSaveBytes(): number
  /** 观测:最近一次 save/load 的错误(无错返回 null)。 */
  getLastError(): string | null
}

export interface SnapshotStoreSnapshot {
  namespace: string
  schemaVersion: number
  lastSavedAt: number | null
  lastLoadedAt: number | null
  lastSaveBytes: number
  lastError: string | null
}

export interface CreateSnapshotStoreOptions<T> {
  /** 唯一标识 —— 也是落盘文件名前缀(`<namespace>.json`)。 */
  namespace: string
  /** 数据格式版本。schema 不兼容时 bump,旧文件会被忽略。默认 1。 */
  schemaVersion?: number
  /** 调用方在 save 时提供当前快照。返回 null 视为"无内容可写"(跳过 save)。 */
  getSnapshot: () => T | null
  /** load 成功后把数据交还调用方。抛错会被吞掉。 */
  applySnapshot: (snapshot: T) => void
  /**
   * 是否注册到进程级 registry(供 /kernel-status 迭代)。默认 true。
   * 测试里若只想局部创建一个 store 可传 false。
   */
  registerInRegistry?: boolean
}

// ── 注册表 ───────────────────────────────────────────────

const stores = new Map<string, SnapshotStoreHandle<unknown>>()

export function getAllSnapshotStores(): SnapshotStoreSnapshot[] {
  return Array.from(stores.values()).map(h => ({
    namespace: h.namespace,
    schemaVersion: h.schemaVersion,
    lastSavedAt: h.getLastSavedAt(),
    lastLoadedAt: h.getLastLoadedAt(),
    lastSaveBytes: h.getLastSaveBytes(),
    lastError: h.getLastError(),
  }))
}

export function getSnapshotStoreByNamespace(
  namespace: string,
): SnapshotStoreHandle<unknown> | undefined {
  return stores.get(namespace)
}

/** 仅供测试:清空注册表。 */
export function __resetSnapshotStoreRegistryForTests(): void {
  stores.clear()
}

// ── 文件工具 ─────────────────────────────────────────────

function buildSnapshotFilePath(projectDir: string, namespace: string): string {
  // 与 episodes/ 对称:<projectDir>/snapshots/<namespace>.json
  return path.join(projectDir, 'snapshots', `${namespace}.json`)
}

// 防止并发调用 saveNow 时 tmp 路径命中同毫秒冲突:
//   两个 saveNow 在 1ms 内同时触发,Date.now() 返回相同值 → tmp 路径相同
//   → 一个 writeFile 覆盖另一个 → 先 rename 的把 tmp 移走,后 rename ENOENT。
// 加一个单调递增计数器即可根除这个竞态。
let atomicWriteSeq = 0

/**
 * 原子写入:tmp + rename。rename 是 POSIX 原子操作,半写文件不会出现。
 * Windows 上 rename 也等价(ExFAT 除外,但 node 内部已处理)。
 */
async function atomicWriteFile(
  filePath: string,
  content: string,
): Promise<void> {
  const dir = path.dirname(filePath)
  await fs.promises.mkdir(dir, { recursive: true })
  const seq = ++atomicWriteSeq
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${seq}`
  await fs.promises.writeFile(tmp, content, 'utf-8')
  await fs.promises.rename(tmp, filePath)
}

// ── 工厂 ──────────────────────────────────────────────────

export function createSnapshotStore<T>(
  opts: CreateSnapshotStoreOptions<T>,
): SnapshotStoreHandle<T> {
  if (!opts.namespace || typeof opts.namespace !== 'string') {
    throw new Error('createSnapshotStore: namespace is required')
  }
  const schemaVersion = Number.isFinite(opts.schemaVersion as number)
    ? (opts.schemaVersion as number)
    : 1

  let lastSavedAt: number | null = null
  let lastLoadedAt: number | null = null
  let lastSaveBytes = 0
  let lastError: string | null = null

  const handle: SnapshotStoreHandle<T> = {
    namespace: opts.namespace,
    schemaVersion,

    async saveNow(projectDir: string): Promise<boolean> {
      try {
        if (!projectDir) return false
        const snap = opts.getSnapshot()
        if (snap === null || snap === undefined) return false
        const envelope = {
          schemaVersion,
          savedAt: Date.now(),
          data: snap,
        }
        const content = JSON.stringify(envelope)
        const filePath = buildSnapshotFilePath(projectDir, opts.namespace)
        await atomicWriteFile(filePath, content)
        lastSavedAt = Date.now()
        lastSaveBytes = Buffer.byteLength(content, 'utf-8')
        lastError = null
        return true
      } catch (e) {
        // 永不抛:落盘失败不能影响主链路
        lastError = (e as Error).message
        logForDebugging(
          `[snapshotStore] save failed for "${opts.namespace}": ${lastError}`,
        )
        return false
      }
    },

    async loadNow(projectDir: string): Promise<boolean> {
      try {
        if (!projectDir) return false
        const filePath = buildSnapshotFilePath(projectDir, opts.namespace)
        let content: string
        try {
          content = await fs.promises.readFile(filePath, 'utf-8')
        } catch {
          // 文件不存在视为正常的"首次启动"
          return false
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(content)
        } catch (e) {
          lastError = `corrupt: ${(e as Error).message}`
          logForDebugging(
            `[snapshotStore] corrupt snapshot for "${opts.namespace}", ignoring`,
          )
          return false
        }
        if (
          typeof parsed !== 'object' ||
          parsed === null ||
          (parsed as { schemaVersion?: number }).schemaVersion !== schemaVersion
        ) {
          // schema 不兼容 → 直接忽略
          return false
        }
        const data = (parsed as { data?: T }).data
        if (data === undefined) return false
        try {
          opts.applySnapshot(data)
        } catch (e) {
          lastError = `apply failed: ${(e as Error).message}`
          logForDebugging(
            `[snapshotStore] applySnapshot threw for "${opts.namespace}": ${lastError}`,
          )
          return false
        }
        lastLoadedAt = Date.now()
        lastError = null
        return true
      } catch (e) {
        lastError = (e as Error).message
        logForDebugging(
          `[snapshotStore] load failed for "${opts.namespace}": ${lastError}`,
        )
        return false
      }
    },

    async deleteNow(projectDir: string): Promise<boolean> {
      try {
        if (!projectDir) return false
        const filePath = buildSnapshotFilePath(projectDir, opts.namespace)
        await fs.promises.unlink(filePath)
        return true
      } catch {
        // 不存在 / 权限问题 —— 吞掉
        return false
      }
    },

    getLastSavedAt: () => lastSavedAt,
    getLastLoadedAt: () => lastLoadedAt,
    getLastSaveBytes: () => lastSaveBytes,
    getLastError: () => lastError,
  }

  const shouldRegister = opts.registerInRegistry ?? true
  if (shouldRegister) {
    stores.set(opts.namespace, handle as SnapshotStoreHandle<unknown>)
  }

  return handle
}
