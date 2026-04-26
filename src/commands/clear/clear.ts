import type { LocalCommandCall } from '../../types/command.js'
import { clearConversation } from './conversation.js'

// /clear 恢复为“新开会话”语义：调用 clearConversation 清空消息并重置 session 状态。
// 之前为了配合自动压缩曾把 /clear 重定向到 /compact，导致用户输入 /clear 实际触发压缩。
// 自动压缩机制（auto-compact / microCompact）走独立路径，不依赖此重定向；
// /compact 命令仍独立保留用于保留摘要的上下文压缩。
export const call: LocalCommandCall = async (_, context) => {
  await clearConversation(context)
  return { type: 'text', value: '' }
}
