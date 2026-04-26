import { resolve } from 'node:path'

import { ASYNC_AGENT_ALLOWED_TOOLS } from '../../../constants/tools.js'
import {
  evaluateShadowSandboxTool,
  type ShadowSandboxVerdict,
} from './sandboxFilter.js'
import { createShadowRuntimeToolUseContext, getShadowRuntimeTools } from './shadowRuntimeContext.js'
import type { ShadowRunExecution, ShadowRunPlan } from './shadowRunner.js'
import { invokeShadowToolUse } from './shadowToolRuntime.js'

const DEFAULT_READ_TARGET_FILES = ['package.json']
const DEFAULT_GLOB_PATTERN = '**/*'
const DEFAULT_GREP_NEEDLE = 'autoEvolve'
const DEFAULT_GREP_HEAD_LIMIT = 1
const DEFAULT_PREVIEW_RENDER_CHARS = 240
const READ_PREVIEW_RENDER_CHARS = 240
const GLOB_PREVIEW_RENDER_CHARS = 240
const GREP_PREVIEW_RENDER_CHARS = 220
const WEB_PREVIEW_SOURCE_BYTES = 1200
const WEB_PREVIEW_RENDER_CHARS = 320

function normalizeRelPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '')
}

function previewText(s: string, max = DEFAULT_PREVIEW_RENDER_CHARS): string {
  const oneLine = s.replace(/\s+/g, ' ').trim()
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}...`
}

function isAllowedShadowWebUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (!(url.protocol === 'https:' || url.protocol === 'http:')) {
      return false
    }
    const hostname = url.hostname.toLowerCase()
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '0.0.0.0' ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.internal')
    ) {
      return false
    }
    return true
  } catch {
    return false
  }
}

function createReadExecutionInput(relTargetFiles: string[]): Record<string, unknown> {
  return {
    files: relTargetFiles,
    defaultFiles: DEFAULT_READ_TARGET_FILES,
    previewChars: READ_PREVIEW_RENDER_CHARS,
  }
}

function createGlobExecutionInput(cwd: string, globPattern: string): Record<string, unknown> {
  return {
    root: cwd,
    pattern: globPattern,
    previewChars: GLOB_PREVIEW_RENDER_CHARS,
  }
}

function createGrepExecutionInput(
  cwd: string,
  grepNeedle: string,
  isRegex: boolean,
  grepHeadLimit: number,
): Record<string, unknown> {
  return {
    root: cwd,
    needle: grepNeedle,
    isRegex,
    headLimit: grepHeadLimit,
    previewChars: GREP_PREVIEW_RENDER_CHARS,
  }
}

function createWebExecutionInput(
  webUrl: string,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    url: webUrl,
    previewBytes: WEB_PREVIEW_SOURCE_BYTES,
    previewChars: WEB_PREVIEW_RENDER_CHARS,
    ...extra,
  }
}

function isValidRegexPattern(value: string): boolean {
  try {
    new RegExp(value, 'm')
    return true
  } catch {
    return false
  }
}

function createExecutionSummary(args:
  | { toolName: 'Read'; ok: boolean; successCount: number; totalCount: number }
  | { toolName: 'Glob'; ok: boolean; matchCount: number }
  | { toolName: 'Grep'; ok: boolean; matchCount: number }
  | { toolName: 'WebFetch'; ok: boolean; code?: number; codeText?: string }
  | { toolName: 'RuntimeBlocked'; ok: false }
  | { toolName: 'WebPolicyBlocked'; ok: false }): string {
  if (args.toolName === 'Read') {
    return args.ok
      ? `read ${args.successCount}/${args.totalCount} file(s) via worker-compatible runtime`
      : `read failed for ${args.totalCount} file(s)`
  }
  if (args.toolName === 'Glob') {
    return args.matchCount > 0
      ? `matched ${args.matchCount} path(s) via worker-compatible runtime`
      : 'matched 0 path(s) via worker-compatible runtime'
  }
  if (args.toolName === 'Grep') {
    return args.matchCount > 0
      ? `matched ${args.matchCount} file(s) via worker-compatible runtime`
      : 'matched 0 file(s) via worker-compatible runtime'
  }
  if (args.toolName === 'WebFetch') {
    return typeof args.code === 'number'
      ? `fetched ${args.code}${args.codeText ? ` ${args.codeText}` : ''} via worker-compatible runtime`
      : 'fetched via worker-compatible runtime'
  }
  if (args.toolName === 'WebPolicyBlocked') {
    return 'blocked before fetch'
  }
  return 'blocked by runtime sandbox'
}

function getShadowSandboxVerdict(toolName: string): ShadowSandboxVerdict {
  return evaluateShadowSandboxTool(toolName)
}

export function getShadowWorkerAllowedTools(requestedTools: readonly string[]): string[] {
  const uniqueRequested = [...new Set(requestedTools.filter(Boolean))]
  return uniqueRequested.filter(name => {
    if (!ASYNC_AGENT_ALLOWED_TOOLS.has(name)) {
      return false
    }
    return getShadowSandboxVerdict(name).decision === 'allow'
  })
}

export async function runShadowWorkerPlan(plan: ShadowRunPlan): Promise<ShadowRunExecution[]> {
  const executions: ShadowRunExecution[] = []
  const cwd = plan.worktreePath
  const relTargetFiles =
    plan.inputs.targetFiles && plan.inputs.targetFiles.length > 0
      ? plan.inputs.targetFiles.map(f => normalizeRelPath(f)).filter(Boolean)
      : DEFAULT_READ_TARGET_FILES
  const targetFiles = relTargetFiles.map(f => resolve(cwd, f))
  const globPattern = normalizeRelPath(plan.inputs.globPattern || DEFAULT_GLOB_PATTERN)
  const grepNeedle =
    plan.inputs.grepNeedle || plan.inputs.queryText || DEFAULT_GREP_NEEDLE
  const grepHeadLimit =
    typeof plan.inputs.grepHeadLimit === 'number' && plan.inputs.grepHeadLimit > 0
      ? Math.floor(plan.inputs.grepHeadLimit)
      : DEFAULT_GREP_HEAD_LIMIT
  const webUrl = plan.inputs.webUrl || 'https://example.com'

  for (const toolName of plan.allowedTools) {
    if (toolName === 'Read') {
      const readResults: string[] = []
      let readSuccessCount = 0
      for (const [index, target] of targetFiles.entries()) {
        const runtimeReadInput = { file_path: target }
        const invoked = await invokeShadowToolUse({
          tools: getShadowRuntimeTools(),
          toolName: 'Read',
          input: runtimeReadInput,
          context: createShadowRuntimeToolUseContext(),
        })
        const rel = relTargetFiles[index] || target.replace(`${cwd}/`, '')
        if (!invoked.ok) {
          readResults.push(`${rel}: ${invoked.reason}`)
          continue
        }
        const raw = invoked.toolResult as {
          data?: {
            type?: string
            file?: { filePath?: string }
            content?: string
          }
        }
        if (raw.data?.type === 'file_unchanged') {
          readSuccessCount += 1
          readResults.push(`unchanged: ${raw.data.file?.filePath ?? target}`)
          continue
        }
        if (typeof raw.data?.content === 'string') {
          readSuccessCount += 1
          readResults.push(`${rel}: ${previewText(raw.data.content, READ_PREVIEW_RENDER_CHARS)}`)
          continue
        }
        readResults.push(`${rel}: empty runtime read result`)
      }
      executions.push({
        toolName: 'Read',
        ok: readSuccessCount > 0,
        summary: createExecutionSummary({
          toolName: 'Read',
          ok: readSuccessCount > 0,
          successCount: readSuccessCount,
          totalCount: targetFiles.length,
        }),
        input: createReadExecutionInput(relTargetFiles),
        outputPreview: previewText(readResults.join(' | '), READ_PREVIEW_RENDER_CHARS),
      })
      continue
    }

    if (toolName === 'Glob') {
      const globInput = { pattern: globPattern, path: cwd }
      const invoked = await invokeShadowToolUse({
        tools: getShadowRuntimeTools(),
        toolName: 'Glob',
        input: globInput,
        context: createShadowRuntimeToolUseContext(),
      })
      if (!invoked.ok) {
        executions.push({
          toolName: 'Glob',
          ok: false,
          summary: createExecutionSummary({ toolName: 'RuntimeBlocked', ok: false }),
          input: createGlobExecutionInput(cwd, globPattern),
          outputPreview: invoked.reason,
        })
      } else {
        const raw = invoked.toolResult as {
          data?: {
            filenames?: string[]
            numFiles?: number
          }
        }
        const filenames = raw.data?.filenames ?? []
        executions.push({
          toolName: 'Glob',
          ok: true,
          summary: createExecutionSummary({
            toolName: 'Glob',
            ok: true,
            matchCount: raw.data?.numFiles ?? filenames.length,
          }),
          input: createGlobExecutionInput(cwd, globPattern),
          outputPreview:
            filenames.length > 0
              ? previewText(filenames.join(', '), GLOB_PREVIEW_RENDER_CHARS)
              : `no runtime file matched ${JSON.stringify(globPattern)}`,
        })
      }
      continue
    }

    if (toolName === 'Grep') {
      const grepInput = {
        pattern: grepNeedle,
        path: cwd,
        output_mode: 'files_with_matches',
        head_limit: grepHeadLimit,
      }
      if (plan.inputs.grepIsRegex && !isValidRegexPattern(grepNeedle)) {
        executions.push({
          toolName: 'Grep',
          ok: false,
          summary: 'invalid regex pattern',
          input: createGrepExecutionInput(
            cwd,
            grepNeedle,
            true,
            grepHeadLimit,
          ),
          outputPreview: 'Invalid regular expression pattern for shadow worker grep input',
        })
        continue
      }
      const invoked = await invokeShadowToolUse({
        tools: getShadowRuntimeTools(),
        toolName: 'Grep',
        input: grepInput,
        context: createShadowRuntimeToolUseContext(),
      })
      if (!invoked.ok) {
        executions.push({
          toolName: 'Grep',
          ok: false,
          summary: createExecutionSummary({ toolName: 'RuntimeBlocked', ok: false }),
          input: createGrepExecutionInput(
            cwd,
            grepNeedle,
            Boolean(plan.inputs.grepIsRegex),
            grepHeadLimit,
          ),
          outputPreview: invoked.reason,
        })
      } else {
        const raw = invoked.toolResult as {
          data?: {
            mode?: string
            filenames?: string[]
            numFiles?: number
            content?: string
          }
        }
        const previewSource = raw.data?.mode === 'content'
          ? raw.data?.content ?? ''
          : (raw.data?.filenames ?? []).join(' | ')
        const numFiles = raw.data?.numFiles ?? 0
        executions.push({
          toolName: 'Grep',
          ok: true,
          summary: createExecutionSummary({
            toolName: 'Grep',
            ok: true,
            matchCount: numFiles,
          }),
          input: createGrepExecutionInput(
            cwd,
            grepNeedle,
            Boolean(plan.inputs.grepIsRegex),
            grepHeadLimit,
          ),
          outputPreview:
            previewSource.length > 0
              ? previewText(previewSource, GREP_PREVIEW_RENDER_CHARS)
              : `no runtime file matched ${JSON.stringify(grepNeedle)}`,
        })
      }
      continue
    }

    if (toolName === 'WebFetch') {
      const webInput = { url: webUrl, prompt: 'Return the main content for shadow runtime validation.' }
      if (!isAllowedShadowWebUrl(webUrl)) {
        executions.push({
          toolName: 'WebFetch',
          ok: false,
          summary: createExecutionSummary({ toolName: 'WebPolicyBlocked', ok: false }),
          input: createWebExecutionInput(webUrl),
          outputPreview: 'blocked by shadow web policy: only public http/https URLs are allowed',
        })
        continue
      }
      const invoked = await invokeShadowToolUse({
        tools: getShadowRuntimeTools(),
        toolName: 'WebFetch',
        input: webInput,
        context: createShadowRuntimeToolUseContext(),
      })
      if (!invoked.ok) {
        executions.push({
          toolName: 'WebFetch',
          ok: false,
          summary: createExecutionSummary({ toolName: 'RuntimeBlocked', ok: false }),
          input: createWebExecutionInput(webUrl),
          outputPreview: invoked.reason,
        })
      } else {
        const raw = invoked.toolResult as {
          data?: {
            bytes?: number
            code?: number
            codeText?: string
            result?: string
            url?: string
          }
        }
        const resultText = raw.data?.result ?? ''
        const code = raw.data?.code
        const codeText = raw.data?.codeText
        executions.push({
          toolName: 'WebFetch',
          ok: typeof code === 'number' ? code >= 200 && code < 400 : true,
          summary: createExecutionSummary({
            toolName: 'WebFetch',
            ok: typeof code === 'number' ? code >= 200 && code < 400 : true,
            code,
            codeText,
          }),
          input: createWebExecutionInput(webUrl, {
            bytes: raw.data?.bytes,
            code,
            url: raw.data?.url,
          }),
          outputPreview:
            resultText.length > 0
              ? previewText(resultText.slice(0, WEB_PREVIEW_SOURCE_BYTES), WEB_PREVIEW_RENDER_CHARS)
              : 'empty runtime web result',
        })
      }
    }
  }

  return executions
}
