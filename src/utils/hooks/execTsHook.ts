/**
 * TS/JS 原生钩子执行器
 *
 * 通过动态 import() 加载用户 TS/JS 模块，调用其 default 导出函数。
 * 模块签名: export default async function(input: HookInput): Promise<HookJSONOutput>
 *
 * 安全机制:
 * - 路径解析: 相对路径基于 getCwd()，绝对路径直接使用
 * - 路径校验: 必须在项目目录或 ~/.claude/ 下
 * - 超时控制: 通过 AbortSignal + setTimeout
 * - 错误隔离: try/catch 包裹，不影响其他钩子
 *
 * 相比 command 类型钩子（child_process.spawn），TS 钩子在同一进程内执行，
 * 零子进程开销，适合高频触发的轻量逻辑（如输入校验、格式化检查）。
 */

import { resolve, isAbsolute } from 'path'
import { randomUUID } from 'crypto'
import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js'
import type { HookJSONOutput } from 'src/entrypoints/agentSdkTypes.js'
import { createCombinedAbortSignal } from '../combinedAbortSignal.js'
import { getCwd } from '../cwd.js'
import { logForDebugging } from '../debug.js'
import { errorMessage } from '../errors.js'
import type { TsHook } from '../settings/types.js'
import { createAttachmentMessage } from '../attachments.js'
import type { HookResult } from '../hooks.js'
import { hookJSONOutputSchema } from '../../types/hooks.js'
import { getClaudeConfigHomeDir } from '../envUtils.js'

const DEFAULT_TS_HOOK_TIMEOUT_MS = 30 * 1000 // 30 秒（TS 钩子应比 shell 钩子快得多）

/**
 * 校验模块路径是否在允许的范围内（项目目录或 ~/.claude/）
 */
function isPathAllowed(resolvedPath: string): boolean {
  const cwd = getCwd()
  const claudeHome = getClaudeConfigHomeDir()
  return resolvedPath.startsWith(cwd) || resolvedPath.startsWith(claudeHome)
}

/**
 * 执行 TS/JS 原生钩子
 *
 * @param hook - TS 钩子配置（包含 path、timeout 等）
 * @param hookName - 钩子显示名称（如 "PreToolUse:Bash"）
 * @param hookEvent - 钩子事件类型
 * @param jsonInput - 序列化的钩子输入 JSON 字符串
 * @param signal - 外部 abort 信号
 * @param toolUseID - 关联的 tool_use ID
 * @returns HookResult — 与 execPromptHook 同构的结果
 */
export async function execTsHook(
  hook: TsHook,
  hookName: string,
  hookEvent: HookEvent,
  jsonInput: string,
  signal: AbortSignal,
  toolUseID?: string,
): Promise<HookResult> {
  const hookId = `ts-hook-${randomUUID()}`
  const hookStartMs = Date.now()
  const hookCommand = `ts:${hook.path}`
  const effectiveToolUseID = toolUseID || hookId

  // 1. 路径解析
  const resolvedPath = isAbsolute(hook.path)
    ? hook.path
    : resolve(getCwd(), hook.path)

  logForDebugging(`Hooks: TS hook resolving path: ${hook.path} → ${resolvedPath}`)

  // 2. 安全检查：路径必须在项目目录或 ~/.claude/ 下
  if (!isPathAllowed(resolvedPath)) {
    const errMsg = `TS hook blocked: path "${resolvedPath}" is outside project directory and ~/.claude/`
    logForDebugging(errMsg, { level: 'warn' })
    return {
      message: createAttachmentMessage({
        type: 'hook_non_blocking_error',
        hookName,
        toolUseID: effectiveToolUseID,
        hookEvent,
        stderr: errMsg,
        stdout: '',
        exitCode: 1,
        command: hookCommand,
        durationMs: Date.now() - hookStartMs,
      }),
      outcome: 'non_blocking_error',
      hook,
    }
  }

  // 3. 超时控制
  const timeoutMs = hook.timeout
    ? hook.timeout * 1000
    : DEFAULT_TS_HOOK_TIMEOUT_MS
  const { signal: combinedSignal, cleanup } = createCombinedAbortSignal(
    signal,
    { timeoutMs },
  )

  try {
    // 4. 动态 import 加载模块
    logForDebugging(`Hooks: TS hook importing module: ${resolvedPath}`)
    const module = await import(resolvedPath)

    if (typeof module.default !== 'function') {
      cleanup()
      const errMsg = `TS hook error: module "${hook.path}" does not export a default function`
      logForDebugging(errMsg, { level: 'error' })
      return {
        message: createAttachmentMessage({
          type: 'hook_non_blocking_error',
          hookName,
          toolUseID: effectiveToolUseID,
          hookEvent,
          stderr: errMsg,
          stdout: '',
          exitCode: 1,
          command: hookCommand,
          durationMs: Date.now() - hookStartMs,
        }),
        outcome: 'non_blocking_error',
        hook,
      }
    }

    // 5. 检查是否已被 abort
    if (combinedSignal.aborted) {
      cleanup()
      return {
        message: createAttachmentMessage({
          type: 'hook_cancelled',
          hookName,
          toolUseID: effectiveToolUseID,
          hookEvent,
        }),
        outcome: 'cancelled',
        hook,
      }
    }

    // 6. 解析输入并调用模块 default 函数
    const parsedInput = JSON.parse(jsonInput)
    const rawResult: unknown = await module.default(parsedInput, combinedSignal)
    cleanup()

    const durationMs = Date.now() - hookStartMs
    logForDebugging(`Hooks: TS hook completed in ${durationMs}ms`)

    // 7. 如果返回 undefined/null，视为成功无输出
    if (rawResult == null) {
      return {
        message: createAttachmentMessage({
          type: 'hook_success',
          hookName,
          toolUseID: effectiveToolUseID,
          hookEvent,
          content: `TS hook ${hook.path} completed`,
          stdout: '',
          stderr: '',
          exitCode: 0,
          command: hookCommand,
          durationMs,
        }),
        outcome: 'success',
        hook,
      }
    }

    // 8. 验证输出是否符合 HookJSONOutput schema
    const validation = hookJSONOutputSchema().safeParse(rawResult)
    if (!validation.success) {
      const errors = validation.error.issues
        .map(err => `  - ${err.path.join('.')}: ${err.message}`)
        .join('\n')
      const errMsg = `TS hook output validation failed:\n${errors}`
      logForDebugging(errMsg, { level: 'warn' })
      return {
        message: createAttachmentMessage({
          type: 'hook_non_blocking_error',
          hookName,
          toolUseID: effectiveToolUseID,
          hookEvent,
          stderr: errMsg,
          stdout: JSON.stringify(rawResult),
          exitCode: 1,
          command: hookCommand,
          durationMs,
        }),
        outcome: 'non_blocking_error',
        hook,
      }
    }

    const json = validation.data as HookJSONOutput

    // 9. 处理 decision 字段（与 prompt/agent hook 一致的逻辑）
    if ('decision' in json && json.decision === 'block') {
      return {
        blockingError: {
          blockingError: ('reason' in json && json.reason) || 'Blocked by TS hook',
          command: hookCommand,
        },
        outcome: 'blocking',
        hook,
      }
    }

    // 10. 返回成功结果
    return {
      message: createAttachmentMessage({
        type: 'hook_success',
        hookName,
        toolUseID: effectiveToolUseID,
        hookEvent,
        content: `TS hook ${hook.path} completed`,
        stdout: JSON.stringify(rawResult),
        stderr: '',
        exitCode: 0,
        command: hookCommand,
        durationMs,
      }),
      outcome: 'success',
      hook,
    }
  } catch (error) {
    cleanup()

    if (combinedSignal.aborted) {
      return {
        message: createAttachmentMessage({
          type: 'hook_cancelled',
          hookName,
          toolUseID: effectiveToolUseID,
          hookEvent,
        }),
        outcome: 'cancelled',
        hook,
      }
    }

    const errMsg = errorMessage(error)
    logForDebugging(`Hooks: TS hook error: ${errMsg}`, { level: 'error' })
    return {
      message: createAttachmentMessage({
        type: 'hook_non_blocking_error',
        hookName,
        toolUseID: effectiveToolUseID,
        hookEvent,
        stderr: `TS hook error: ${errMsg}`,
        stdout: '',
        exitCode: 1,
        command: hookCommand,
        durationMs: Date.now() - hookStartMs,
      }),
      outcome: 'non_blocking_error',
      hook,
    }
  }
}
