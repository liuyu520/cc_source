// 外部 Agent 委派工具的系统提示词描述

import {
  DELEGATE_TO_EXTERNAL_AGENT_TOOL_NAME,
  CHECK_DELEGATE_STATUS_TOOL_NAME,
  GET_DELEGATE_RESULT_TOOL_NAME,
} from './constants.js'

export { DELEGATE_TO_EXTERNAL_AGENT_TOOL_NAME, CHECK_DELEGATE_STATUS_TOOL_NAME, GET_DELEGATE_RESULT_TOOL_NAME }

export const DELEGATE_DESCRIPTION = `
Delegate a sub-task to an external AI Agent CLI (Codex, Gemini, Claude Code, etc.) running as a separate process on the local machine.

Usage:
- Use this when you want to parallelize work across different AI agents or leverage a specific agent's strengths
- The external agent runs independently with full filesystem access in the specified working directory
- Supported agent types: 'codex', 'gemini', 'claude-code', or any custom CLI configured by the user
- By default runs in background mode - you will be notified when the task completes via <task-notification>
- Permission requests from the external agent are automatically approved

Available agent types:
- codex: OpenAI Codex CLI (requires 'codex' to be installed)
- gemini: Google Gemini CLI (requires 'gemini' to be installed)
- claude-code: Another Claude Code CLI instance (requires 'claude' to be installed)
`

export const CHECK_STATUS_DESCRIPTION = `
Check the current status and progress of a delegated external agent task.

- Takes a delegate_id returned by DelegateToExternalAgent
- Returns the current status, progress summary, elapsed time, and event count
- Use this to monitor long-running delegated tasks
`

export const GET_RESULT_DESCRIPTION = `
Get the complete result from a delegated external agent task.

- Takes a delegate_id returned by DelegateToExternalAgent
- Use block=true to wait for the task to complete before returning
- Returns the final result text, tool usage summary, token counts, and any errors
- If the task is still running and block=false, returns status 'running'
`
