/**
 * SmartApprove 持久化权限缓存
 *
 * 三级查找：
 * 1. 持久化缓存命中 → 直接决策
 * 2. MCP tool readOnlyHint annotation → 缓存并决策
 * 3. 缓存未命中 → 回退到 classifyYoloAction（由调用方执行）
 *
 * 缓存存储在 ~/.claude/smart_permissions.json
 * 格式：{ "toolName": "readOnly" | "write", ... }
 */

import * as path from 'node:path'
import * as fs from 'node:fs'
import { homedir } from 'os'
import { logForDebugging } from '../debug.js'

type ToolClassification = 'readOnly' | 'write'

interface SmartApproveCacheData {
  [toolName: string]: ToolClassification
}

// 缓存文件名
const CACHE_FILENAME = 'smart_permissions.json'

// 内存缓存，避免每次都读磁盘
let memoryCache: SmartApproveCacheData | null = null

/**
 * 获取缓存文件的完整路径：~/.claude/smart_permissions.json
 */
function getCachePath(): string {
  return path.join(homedir(), '.claude', CACHE_FILENAME)
}

/**
 * 从磁盘加载缓存到内存
 * 文件不存在或损坏时返回空对象
 */
function loadCache(): SmartApproveCacheData {
  if (memoryCache !== null) {
    return memoryCache
  }
  try {
    const cachePath = getCachePath()
    if (fs.existsSync(cachePath)) {
      const raw = fs.readFileSync(cachePath, 'utf-8')
      const parsed = JSON.parse(raw)
      // 简单校验：确保是普通对象
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        memoryCache = parsed as SmartApproveCacheData
        return memoryCache
      }
    }
  } catch (e) {
    // 文件损坏或读取失败，静默回退到空缓存
    logForDebugging(
      `SmartApprove cache load failed, using empty cache: ${e}`,
      { level: 'warn' },
    )
  }
  memoryCache = {}
  return memoryCache
}

/**
 * 将内存缓存持久化到磁盘
 * 使用同步写入，文件很小（通常 < 1KB）
 */
function persistCache(cache: SmartApproveCacheData): void {
  try {
    const cachePath = getCachePath()
    // 确保 ~/.claude/ 目录存在
    const dir = path.dirname(cachePath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf-8')
  } catch (e) {
    // 写入失败不影响功能，仅记录日志
    logForDebugging(
      `SmartApprove cache persist failed: ${e}`,
      { level: 'warn' },
    )
  }
}

/**
 * 查询 SmartApprove 缓存
 *
 * 三级查找逻辑：
 * 1. 持久化缓存命中 → 根据分类返回 'allow'（readOnly）或 'ask'（write）
 * 2. MCP tool 的 readOnlyHint annotation → 写入缓存并返回 'allow'
 * 3. 缓存未命中 → 返回 null，由调用方走 classifyYoloAction
 *
 * @param toolName - 工具名称（如 mcp__server__tool 或内置工具名）
 * @param mcpReadOnlyHint - MCP 工具的 readOnlyHint annotation 值
 * @returns 'allow' | 'ask' | null
 */
export function querySmartApproveCache(
  toolName: string,
  mcpReadOnlyHint?: boolean,
): 'allow' | 'ask' | null {
  const cache = loadCache()

  // 第一级：持久化缓存命中
  const cached = cache[toolName]
  if (cached !== undefined) {
    logForDebugging(
      `SmartApprove cache hit for ${toolName}: ${cached}`,
    )
    return cached === 'readOnly' ? 'allow' : 'ask'
  }

  // 第二级：MCP tool readOnlyHint annotation
  if (mcpReadOnlyHint === true) {
    logForDebugging(
      `SmartApprove: MCP readOnlyHint detected for ${toolName}, caching as readOnly`,
    )
    // 写入缓存并持久化
    cache[toolName] = 'readOnly'
    memoryCache = cache
    persistCache(cache)
    return 'allow'
  }

  // 第三级：缓存未命中
  return null
}

/**
 * 记录分类器结果到缓存
 * 在 classifyYoloAction 返回后由调用方调用
 *
 * @param toolName - 工具名称
 * @param shouldBlock - classifyYoloAction 返回的 shouldBlock 值
 *   true → 工具被判定为写操作（'write'）
 *   false → 工具被判定为只读操作（'readOnly'）
 */
export function recordSmartApproveResult(
  toolName: string,
  shouldBlock: boolean,
): void {
  const cache = loadCache()
  const classification: ToolClassification = shouldBlock ? 'write' : 'readOnly'

  // 仅当分类结果变化或首次记录时才写入
  if (cache[toolName] !== classification) {
    cache[toolName] = classification
    memoryCache = cache
    persistCache(cache)
    logForDebugging(
      `SmartApprove: recorded ${toolName} as ${classification}`,
    )
  }
}

/**
 * 清除缓存（用于测试或用户手动重置）
 * 同时清除内存缓存和磁盘文件
 */
export function clearSmartApproveCache(): void {
  memoryCache = null
  try {
    const cachePath = getCachePath()
    if (fs.existsSync(cachePath)) {
      fs.unlinkSync(cachePath)
    }
  } catch (e) {
    logForDebugging(
      `SmartApprove cache clear failed: ${e}`,
      { level: 'warn' },
    )
  }
}
