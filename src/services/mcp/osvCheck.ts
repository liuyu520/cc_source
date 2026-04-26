/**
 * OSV 恶意包检测 — 在 MCP server spawn 前检查 npm/pypi 包是否有 MAL- 类 advisory
 *
 * 设计原则：
 * - fail-open：查询失败时放行，不阻断开发
 * - 内存缓存：同会话不重复查询同一包
 * - 只检查 npx/bunx/uvx 启动的包（其他命令跳过）
 */

import { logMCPDebug, logMCPError } from '../../utils/log.js'

// 内存缓存：包名 → 是否安全（true=安全, false=恶意）
const packageSafetyCache = new Map<string, boolean>()

// npx / bunx 常见的 flag，解析时需要跳过这些参数以定位真正的包名
const NPX_FLAGS_WITH_VALUE = new Set(['-p', '--package', '-c'])
const NPX_FLAGS_NO_VALUE = new Set(['-y', '--yes', '-q', '--quiet', '--no-install', '--prefer-offline'])

/**
 * 解析 npx/bunx/uvx 命令中的包名
 * 例如: npx @modelcontextprotocol/server-filesystem → { ecosystem: 'npm', name: '@modelcontextprotocol/server-filesystem' }
 * 例如: uvx mcp-server-git → { ecosystem: 'PyPI', name: 'mcp-server-git' }
 * 例如: node xxx → null（跳过）
 */
export function parsePackageFromCommand(
  command: string,
  args: string[],
): { ecosystem: string; name: string; version?: string } | null {
  // 提取命令的 basename（去除路径前缀）
  const basename = command.split('/').pop() ?? command

  // 判断命令类型，确定对应的包生态系统
  const isNpxOrBunx = basename === 'npx' || basename === 'bunx'
  const isUvx = basename === 'uvx'

  // 非 npx/bunx/uvx 命令直接跳过
  if (!isNpxOrBunx && !isUvx) {
    return null
  }

  const ecosystem = isUvx ? 'PyPI' : 'npm'

  // 遍历 args，跳过 flag，找到第一个非 flag 参数即为包名
  let i = 0
  while (i < args.length) {
    const arg = args[i]!

    // 跳过 -- 后面的所有参数（传递给子命令的参数）
    if (arg === '--') {
      break
    }

    // 跳过带值的 flag（如 -p <pkg>）
    if (NPX_FLAGS_WITH_VALUE.has(arg)) {
      i += 2
      continue
    }

    // 跳过无值 flag（如 -y、--yes）
    if (NPX_FLAGS_NO_VALUE.has(arg) || arg.startsWith('--')) {
      i += 1
      continue
    }

    // 跳过短横线开头的未知 flag
    if (arg.startsWith('-') && !arg.startsWith('@')) {
      i += 1
      continue
    }

    // 找到包名，解析可能带版本号的格式（如 package@1.0.0）
    return parsePackageName(arg, ecosystem)
  }

  return null
}

/**
 * 解析包名，支持 @scope/name@version 和 name@version 格式
 */
function parsePackageName(
  raw: string,
  ecosystem: string,
): { ecosystem: string; name: string; version?: string } {
  // 处理 scoped 包：@scope/name@version
  if (raw.startsWith('@')) {
    const slashIdx = raw.indexOf('/')
    if (slashIdx === -1) {
      return { ecosystem, name: raw }
    }
    // 在 scope 之后查找版本分隔符 @
    const afterScope = raw.slice(slashIdx + 1)
    const atIdx = afterScope.indexOf('@')
    if (atIdx === -1) {
      return { ecosystem, name: raw }
    }
    return {
      ecosystem,
      name: raw.slice(0, slashIdx + 1 + atIdx),
      version: afterScope.slice(atIdx + 1),
    }
  }

  // 普通包：name@version
  const atIdx = raw.indexOf('@')
  if (atIdx === -1) {
    return { ecosystem, name: raw }
  }
  return {
    ecosystem,
    name: raw.slice(0, atIdx),
    version: raw.slice(atIdx + 1),
  }
}

/**
 * 查询 OSV API，检查包是否有 MAL- 前缀的恶意软件 advisory
 * POST https://api.osv.dev/v1/query
 * 只关心 id 以 "MAL-" 开头的 advisory（恶意软件标记）
 */
async function queryOSV(
  ecosystem: string,
  name: string,
  version?: string,
): Promise<{ id: string; summary: string }[]> {
  const body: Record<string, unknown> = {
    package: { ecosystem, name },
  }
  if (version) {
    body.version = version
  }

  // 3 秒超时，避免阻塞 MCP 启动
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 3000)

  try {
    const resp = await fetch('https://api.osv.dev/v1/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    if (!resp.ok) {
      throw new Error(`OSV API returned ${resp.status}`)
    }

    const data = (await resp.json()) as { vulns?: Array<{ id: string; summary?: string }> }

    // 只筛选 MAL- 前缀的 advisory（恶意软件标记）
    const malicious = (data.vulns ?? []).filter((v) => v.id.startsWith('MAL-'))
    return malicious.map((v) => ({
      id: v.id,
      summary: v.summary ?? '',
    }))
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * 主函数：在 MCP server spawn 前调用
 * 如果检测到恶意包，抛出错误阻止 spawn
 * 查询失败时 fail-open（只打日志，不阻断）
 */
export async function denyIfMalicious(
  command: string,
  args: string[],
): Promise<void> {
  const pkg = parsePackageFromCommand(command, args)

  // 非 npx/bunx/uvx 命令，跳过检查
  if (!pkg) {
    return
  }

  const cacheKey = `${pkg.ecosystem}:${pkg.name}${pkg.version ? '@' + pkg.version : ''}`

  // 命中缓存：直接返回或抛错
  if (packageSafetyCache.has(cacheKey)) {
    const safe = packageSafetyCache.get(cacheKey)!
    if (!safe) {
      throw new Error(
        `Blocked MCP server: package "${pkg.name}" is flagged as malicious in OSV (cached)`,
      )
    }
    return
  }

  try {
    logMCPDebug('osv-check', `Checking ${cacheKey} against OSV database...`)

    const results = await queryOSV(pkg.ecosystem, pkg.name, pkg.version)

    if (results.length > 0) {
      // 标记为恶意并缓存
      packageSafetyCache.set(cacheKey, false)

      const advisories = results.map((r) => `${r.id}: ${r.summary}`).join('; ')
      throw new Error(
        `Blocked MCP server: package "${pkg.name}" has known malicious advisories: ${advisories}`,
      )
    }

    // 标记为安全并缓存
    packageSafetyCache.set(cacheKey, true)
    logMCPDebug('osv-check', `Package ${cacheKey} passed OSV check`)
  } catch (err) {
    // 如果是我们自己抛出的阻断错误，继续往上抛
    if (err instanceof Error && err.message.startsWith('Blocked MCP server')) {
      throw err
    }

    // 其他错误（网络超时、API 异常等）→ fail-open，只记录日志
    logMCPError('osv-check', err)
  }
}
