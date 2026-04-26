/**
 * MCP 技能获取
 *
 * 从 MCP 服务器的 resources 中发现技能定义。
 * MCP 服务器可通过以下方式暴露技能：
 * 1. URI 前缀为 skill:// 的资源
 * 2. mimeType 为 text/x-skill 的资源
 *
 * 资源内容遵循 SKILL.md frontmatter 格式，
 * 通过 mcpSkillBuilders 注册的解析器转换为 Command 对象。
 *
 * 使用 memoizeWithLRU 缓存，因为 client.ts 中对其调用
 * .cache.delete(name) 来清除重连后的旧缓存。
 */

import {
  type ReadResourceResult,
  ReadResourceResultSchema,
  ListResourcesResultSchema,
} from '@modelcontextprotocol/sdk/types.js'
import type { Command } from '../commands.js'
import type { MCPServerConnection } from '../services/mcp/types.js'
import { logForDebugging } from '../utils/debug.js'
import { errorMessage } from '../utils/errors.js'
import { parseFrontmatter } from '../utils/frontmatterParser.js'
import { logMCPError } from '../utils/log.js'
import { memoizeWithLRU } from '../utils/memoize.js'
import { getMCPSkillBuilders } from './mcpSkillBuilders.js'

/** MCP 技能资源的 URI 前缀 */
const SKILL_URI_PREFIX = 'skill://'
/** MCP 技能资源的 MIME 类型 */
const SKILL_MIME_TYPE = 'text/x-skill'
const SKILL_SUMMARY_HINT_RE = /(manifest|summary|catalog|index)/i
const SKILL_SUMMARY_JSON_HINT_RE = /json/i
const MCP_SKILL_SUMMARY_READ_LIMIT = 24

// 与 client.ts 中其他 fetch 函数一致的缓存大小
const MCP_SKILL_CACHE_SIZE = 20

type SkillResource = {
  uri: string
  name?: string
  description?: string
  mimeType?: string
}

function rankSkillResources(resources: SkillResource[]): SkillResource[] {
  return [...resources].sort((left, right) => {
    const leftScore =
      (left.description ? 4 : 0) +
      (left.name ? 2 : 0) +
      (left.uri.startsWith(SKILL_URI_PREFIX) ? 1 : 0)
    const rightScore =
      (right.description ? 4 : 0) +
      (right.name ? 2 : 0) +
      (right.uri.startsWith(SKILL_URI_PREFIX) ? 1 : 0)
    if (rightScore !== leftScore) {
      return rightScore - leftScore
    }
    return left.uri.localeCompare(right.uri)
  })
}

function compareSkillResources(
  left: SkillResource,
  right: SkillResource,
): number {
  return rankSkillResources([left, right])[0] === left ? -1 : 1
}

function isSkillSummaryResource(resource: SkillResource): boolean {
  const isJsonLike =
    SKILL_SUMMARY_JSON_HINT_RE.test(resource.mimeType ?? '') ||
    resource.uri.endsWith('.json')
  return (
    isJsonLike &&
    SKILL_SUMMARY_HINT_RE.test(`${resource.uri} ${resource.name ?? ''}`)
  )
}

async function readTextResource(
  client: MCPServerConnection,
  resource: SkillResource,
): Promise<string | null> {
  const readResult = (await client.client.request(
    {
      method: 'resources/read',
      params: { uri: resource.uri },
    },
    ReadResourceResultSchema,
  )) as ReadResourceResult

  const textContent = readResult.contents
    ?.map(content => ('text' in content ? content.text : null))
    .filter((text): text is string => text !== null)
    .join('\n')

  return textContent || null
}

function parseSkillSummaryEntries(text: string): string[] | null {
  try {
    const parsed = JSON.parse(text) as unknown
    const rawEntries = Array.isArray(parsed)
      ? parsed
      : parsed &&
          typeof parsed === 'object' &&
          Array.isArray((parsed as { skills?: unknown[] }).skills)
        ? (parsed as { skills: unknown[] }).skills
        : null

    if (!rawEntries) {
      return null
    }

    const entries = rawEntries
      .map(entry => {
        if (typeof entry === 'string') {
          return entry
        }
        if (
          entry &&
          typeof entry === 'object' &&
          typeof (entry as { uri?: unknown }).uri === 'string'
        ) {
          return (entry as { uri: string }).uri
        }
        return null
      })
      .filter((entry): entry is string => entry !== null)

    return entries.length > 0 ? entries : null
  } catch {
    return null
  }
}

function getSkillResourceAliases(resource: SkillResource): string[] {
  const aliases = new Set<string>([resource.uri])
  if (resource.name) {
    aliases.add(resource.name)
  }
  const uriTail = resource.uri.replace(SKILL_URI_PREFIX, '').split('/').pop()
  if (uriTail) {
    aliases.add(uriTail)
  }
  return [...aliases]
}

function applySkillSummaryOrdering(
  resources: SkillResource[],
  summaryEntries: string[],
): SkillResource[] {
  const orderByAlias = new Map<string, number>()
  summaryEntries.forEach((entry, index) => {
    orderByAlias.set(entry, index)
  })

  const scoreFor = (resource: SkillResource): number | null => {
    let best: number | null = null
    for (const alias of getSkillResourceAliases(resource)) {
      const rank = orderByAlias.get(alias)
      if (rank === undefined) {
        continue
      }
      if (best === null || rank < best) {
        best = rank
      }
    }
    return best
  }

  const ranked = resources
    .map(resource => ({ resource, rank: scoreFor(resource) }))
    .sort((left, right) => {
      if (left.rank !== null && right.rank !== null && left.rank !== right.rank) {
        return left.rank - right.rank
      }
      if (left.rank !== null) {
        return -1
      }
      if (right.rank !== null) {
        return 1
      }
      return compareSkillResources(left.resource, right.resource)
    })

  return ranked.map(entry => entry.resource)
}

async function resolveSkillResourcesToRead(
  client: MCPServerConnection,
  resources: SkillResource[],
): Promise<SkillResource[]> {
  const summaryResources = resources.filter(isSkillSummaryResource)
  const skillResources = rankSkillResources(
    resources.filter(resource => !isSkillSummaryResource(resource)),
  )

  if (summaryResources.length === 0) {
    return skillResources
  }

  for (const summaryResource of rankSkillResources(summaryResources)) {
    try {
      const text = await readTextResource(client, summaryResource)
      if (!text) {
        continue
      }

      const summaryEntries = parseSkillSummaryEntries(text)
      if (!summaryEntries) {
        continue
      }

      const orderedResources = applySkillSummaryOrdering(
        skillResources,
        summaryEntries,
      )
      if (orderedResources.length > MCP_SKILL_SUMMARY_READ_LIMIT) {
        logForDebugging(
          `fetchMcpSkillsForClient(${client.name}): summary ordered ${orderedResources.length} skills, eagerly reading top ${MCP_SKILL_SUMMARY_READ_LIMIT}`,
        )
        return orderedResources.slice(0, MCP_SKILL_SUMMARY_READ_LIMIT)
      }
      return orderedResources
    } catch (error) {
      logForDebugging(
        `fetchMcpSkillsForClient(${client.name}): failed to read skill summary ${summaryResource.uri}: ${errorMessage(error)}`,
      )
    }
  }

  return skillResources
}

/**
 * 从 MCP 服务器发现并加载技能资源。
 *
 * 流程：
 * 1. 列出服务器的所有资源 (resources/list)
 * 2. 过滤出技能资源 (skill:// URI 或 text/x-skill mimeType)
 * 3. 逐个读取资源内容 (resources/read)
 * 4. 解析 frontmatter 并生成 Command 对象
 *
 * 缓存键为 client.name，与 fetchToolsForClient/fetchCommandsForClient 一致。
 * client.ts 中 onclose 和 disconnectMcpServer 会调用 .cache.delete(name) 清除。
 */
export const fetchMcpSkillsForClient = memoizeWithLRU(
  async (client: MCPServerConnection): Promise<Command[]> => {
    if (client.type !== 'connected') return []

    try {
      // 检查服务器是否支持 resources 能力
      if (!client.capabilities?.resources) {
        return []
      }

      // 1. 列出所有资源
      const listResult = await client.client.request(
        { method: 'resources/list' },
        ListResourcesResultSchema,
      )

      if (!listResult.resources || listResult.resources.length === 0) {
        return []
      }

      // 2. 过滤技能资源：URI 以 skill:// 开头，或 mimeType 为 text/x-skill
      const skillResources = listResult.resources.filter(
        r =>
          r.uri.startsWith(SKILL_URI_PREFIX) ||
          r.mimeType === SKILL_MIME_TYPE,
      )

      if (skillResources.length === 0) {
        return []
      }

      logForDebugging(
        `fetchMcpSkillsForClient(${client.name}): found ${skillResources.length} skill resources`,
      )
      const resourcesToRead = await resolveSkillResourcesToRead(
        client,
        skillResources,
      )

      // 3. 读取每个技能资源的内容并转换为 Command
      const { parseSkillFrontmatterFields, createSkillCommand } =
        getMCPSkillBuilders()

      const commands: Command[] = []

      for (const resource of resourcesToRead) {
        try {
          const textContent = await readTextResource(client, resource)
          if (!textContent) {
            logForDebugging(
              `fetchMcpSkillsForClient(${client.name}): skill resource ${resource.uri} has no text content, skipping`,
            )
            continue
          }

          // 4. 解析 frontmatter
          const { frontmatter, content: markdownContent } =
            parseFrontmatter(textContent, resource.uri)

          // 从 URI 中提取技能名称：skill://server/skill-name → skill-name
          // 或使用资源的 name 字段
          const rawName =
            resource.name ||
            resource.uri.replace(SKILL_URI_PREFIX, '').split('/').pop() ||
            'unnamed-mcp-skill'

          // 用 mcp__ 前缀 + 服务器名命名，与 fetchCommandsForClient 的 mcp__ 命名一致
          const skillName = `mcp__${client.name}__skill__${rawName}`

          // 5. 解析 frontmatter 字段
          const parsed = parseSkillFrontmatterFields(
            frontmatter,
            markdownContent,
            skillName,
            'Skill',
          )

          // 6. 创建 Command 对象
          const command = createSkillCommand({
            skillName,
            displayName: parsed.displayName || `${client.name}:${rawName} (MCP Skill)`,
            description: parsed.description,
            hasUserSpecifiedDescription: parsed.hasUserSpecifiedDescription,
            markdownContent,
            allowedTools: parsed.allowedTools,
            argumentHint: parsed.argumentHint,
            argumentNames: parsed.argumentNames,
            whenToUse: parsed.whenToUse,
            version: parsed.version,
            model: parsed.model,
            disableModelInvocation: parsed.disableModelInvocation,
            userInvocable: parsed.userInvocable,
            source: 'mcp',
            baseDir: undefined,
            loadedFrom: 'mcp',
            hooks: parsed.hooks,
            executionContext: undefined,
            agent: parsed.agent,
            paths: undefined,
            effort: parsed.effort,
            shell: parsed.shell,
            next: undefined,
            depends: undefined,
            workflowGroup: undefined,
          })

          commands.push(command)
        } catch (resourceError) {
          // 单个资源读取失败不影响其他资源
          logForDebugging(
            `fetchMcpSkillsForClient(${client.name}): failed to read skill resource ${resource.uri}: ${errorMessage(resourceError)}`,
          )
        }
      }

      logForDebugging(
        `fetchMcpSkillsForClient(${client.name}): loaded ${commands.length} skills from ${resourcesToRead.length}/${skillResources.length} resources`,
      )

      return commands
    } catch (error) {
      logMCPError(
        client.name,
        `Failed to fetch MCP skills: ${errorMessage(error)}`,
      )
      return []
    }
  },
  // 缓存键函数：与 fetchToolsForClient/fetchCommandsForClient 一致
  (client: MCPServerConnection) => client.name,
  MCP_SKILL_CACHE_SIZE,
)
