/**
 * MCP Manifest Cache (P1-2) — 冷启动零连接的关键。
 *
 * 存储位置：~/.claude/mcp-manifests.json
 * TTL：24 小时
 *
 * 冷启动：读缓存即可构造工具列表供系统提示使用。
 * 后台预热：启动后异步触发真实探测，更新缓存。
 *
 * 复用 utils/config.ts 的配置目录约定。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { homedir } from 'os'
import type { McpManifest } from './types.js'

const TTL_MS = 24 * 60 * 60 * 1000

function cachePath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  return join(dir, 'mcp-manifests.json')
}

type Shape = Record<string, McpManifest>

/**
 * #4 修复：轻量形状哈希 — 仅比较 tools/commands/resources 的名称 + 描述，
 * 忽略 probedAt/lastUsedAt 等时间戳字段，避免每次状态刷新都触发写盘。
 */
function shapeHash(m: McpManifest): string {
  const pick = (list: { name: string; description?: string }[] | undefined) =>
    (list ?? [])
      .map(x => `${x.name}\u0001${x.description ?? ''}`)
      .sort()
      .join('\u0002')
  return [
    m.serverName,
    m.transport,
    pick(m.tools),
    pick(m.commands),
    pick(m.resources),
  ].join('\u0003')
}

function load(): Shape {
  try {
    const p = cachePath()
    if (!existsSync(p)) return {}
    return JSON.parse(readFileSync(p, 'utf-8')) as Shape
  } catch {
    return {}
  }
}

function save(shape: Shape): void {
  try {
    const p = cachePath()
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify(shape, null, 2))
  } catch {
    // 缓存写入失败不影响主流程
  }
}

export class ManifestCache {
  getAll(): McpManifest[] {
    return Object.values(load())
  }

  get(serverName: string): McpManifest | undefined {
    return load()[serverName]
  }

  isFresh(serverName: string): boolean {
    const m = this.get(serverName)
    if (!m) return false
    return Date.now() - Date.parse(m.probedAt) < TTL_MS
  }

  put(manifest: McpManifest): void {
    const shape = load()
    shape[manifest.serverName] = manifest
    save(shape)
  }

  /**
   * #4 修复：只有当 tools/commands/resources 的"形状"发生变化时才落盘，
   * 避免 tools/list_changed 等高频通知造成 IO 放大。
   * 返回值表示是否真的触发了写入，便于上层埋点 / 单测断言。
   */
  putIfChanged(manifest: McpManifest): boolean {
    const shape = load()
    const prev = shape[manifest.serverName]
    if (prev && shapeHash(prev) === shapeHash(manifest)) {
      // 形状未变 —— 仅刷新 probedAt，不重写整份 JSON
      return false
    }
    shape[manifest.serverName] = manifest
    save(shape)
    return true
  }

  recordCall(serverName: string, success: boolean): void {
    const shape = load()
    const m = shape[serverName]
    if (!m) return
    m.totalCalls = (m.totalCalls ?? 0) + 1
    m.lastUsedAt = new Date().toISOString()
    if (success) {
      m.lastSuccessAt = m.lastUsedAt
      m.consecutiveFailures = 0
    } else {
      m.lastFailureAt = m.lastUsedAt
      m.consecutiveFailures = (m.consecutiveFailures ?? 0) + 1
    }
    save(shape)
  }

  invalidate(serverName: string): void {
    const shape = load()
    delete shape[serverName]
    save(shape)
  }

  clear(): void {
    save({})
  }
}

export const manifestCache = new ManifestCache()
