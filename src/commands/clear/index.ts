/**
 * Clear command - minimal metadata only.
 * Implementation is lazy-loaded from clear.ts to reduce startup time.
 * Utility functions:
 * - clearSessionCaches: import from './clear/caches.js'
 * - clearConversation: import from './clear/conversation.js'
 */
import type { Command } from '../../commands.js'

const clear = {
  type: 'local',
  name: 'clear',
  // /clear 执行新开会话：清空消息历史并重置 session，释放上下文。
  // 保留摘要的压缩请使用 /compact；自动压缩机制独立生效，不依赖此命令。
  description: 'Clear conversation history and free up context',
  aliases: ['reset', 'new'],
  // 新开会话是一次性、交互式操作，不暴露给非交互式脚本调用。
  supportsNonInteractive: false,
  load: () => import('./clear.js'),
} satisfies Command

export default clear
