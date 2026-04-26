// 外部 Agent 委派的共享类型定义

// 外部 Agent 产生的统一事件类型
export interface ExternalAgentEvent {
  type: 'system' | 'text' | 'tool_use' | 'tool_result' | 'thinking' | 'result' | 'permission_request' | 'error'
  data: Record<string, unknown>
  timestamp: number
}

// 委派任务配置
export interface DelegateTask {
  agentType: string
  task: string
  cwd: string
  env: Record<string, string>
  timeout: number
}

// Adapter 构建命令的返回值
export interface AdapterCommand {
  command: string
  args: string[]
  env: Record<string, string>
}

// Adapter 接口
export interface ExternalAgentAdapter {
  name: string
  isAvailable(): Promise<boolean>
  buildCommand(task: DelegateTask): AdapterCommand
  parseOutputLine(line: string): ExternalAgentEvent | null
  buildInputMessage(message: string): string
  buildPermissionResponse(requestId: string, toolInput?: Record<string, unknown>): string
  isSuccessExitCode(code: number): boolean
}

// 会话状态
export type DelegateStatus = 'running' | 'completed' | 'failed'

// 工具调用摘要
export interface ToolUseSummary {
  tool: string
  input_summary: string
}

// DelegateToExternalAgent 工具输出
export interface DelegateOutput {
  delegate_id: string
  status: DelegateStatus
  result?: string
  session_id?: string
}

// CheckDelegateStatus 工具输出
export interface CheckStatusOutput {
  status: DelegateStatus | 'not_found'
  progress?: string
  elapsed_ms?: number
  events_count?: number
}

// GetDelegateResult 工具输出
export interface GetResultOutput {
  status: DelegateStatus | 'not_found'
  result?: string
  tool_uses?: ToolUseSummary[]
  tokens?: { input: number; output: number }
  error?: string
}
