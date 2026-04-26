// src/tools/ExternalAgentDelegate/UI.tsx
// 外部 Agent 委派工具的 Ink 渲染组件

import React from 'react'
import { MessageResponse } from '../../components/MessageResponse.js'
import { Text } from '../../ink.js'
import type { DelegateOutput, CheckStatusOutput, GetResultOutput } from './types.js'

// DelegateToExternalAgent 工具使用消息
export function renderDelegateToolUseMessage(input: {
  agent_type: string
  task: string
}): React.ReactNode {
  const taskPreview = input.task.length > 100
    ? input.task.slice(0, 100) + '...'
    : input.task
  return (
    <MessageResponse>
      <Text>
        Delegating to {input.agent_type}: {taskPreview}
      </Text>
    </MessageResponse>
  )
}

// DelegateToExternalAgent 工具结果消息
export function renderDelegateToolResultMessage(
  output: DelegateOutput,
): React.ReactNode {
  const statusIcon = output.status === 'completed' ? '\u2713' : output.status === 'running' ? '\u23f3' : '\u2717'
  return (
    <MessageResponse>
      <Text>
        {statusIcon} Delegate {output.delegate_id.slice(0, 8)}... [{output.status}]
        {output.result ? ` \u2014 ${output.result.slice(0, 100)}` : ''}
      </Text>
    </MessageResponse>
  )
}

// CheckDelegateStatus 工具使用消息
export function renderCheckStatusToolUseMessage(): React.ReactNode {
  return ''
}

// CheckDelegateStatus 工具结果消息
export function renderCheckStatusToolResultMessage(
  output: CheckStatusOutput,
): React.ReactNode {
  return (
    <MessageResponse>
      <Text>
        Delegate status: {output.status}
        {output.elapsed_ms ? ` (${Math.round(output.elapsed_ms / 1000)}s)` : ''}
        {output.events_count ? ` \u2014 ${output.events_count} events` : ''}
      </Text>
    </MessageResponse>
  )
}

// GetDelegateResult 工具使用消息
export function renderGetResultToolUseMessage(): React.ReactNode {
  return ''
}

// GetDelegateResult 工具结果消息
export function renderGetResultToolResultMessage(
  output: GetResultOutput,
): React.ReactNode {
  const statusIcon = output.status === 'completed' ? '\u2713' : output.status === 'failed' ? '\u2717' : '\u23f3'
  return (
    <MessageResponse>
      <Text>
        {statusIcon} Result [{output.status}]
        {output.result ? `: ${output.result.slice(0, 150)}` : ''}
        {output.error ? ` \u2014 Error: ${output.error.slice(0, 100)}` : ''}
      </Text>
    </MessageResponse>
  )
}
