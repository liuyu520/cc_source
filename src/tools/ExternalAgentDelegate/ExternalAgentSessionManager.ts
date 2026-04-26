// 外部 Agent 会话管理器 — 单例模式，管理所有活跃的委派会话

import { ExternalAgentSession } from './ExternalAgentSession.js'
import type { ExternalAgentAdapter, DelegateTask } from './types.js'

// 完成通知回调类型
export type DelegateCompleteCallback = (session: ExternalAgentSession) => void

class ExternalAgentSessionManagerImpl {
  private sessions = new Map<string, ExternalAgentSession>()
  // 外部注册的完成通知回调（用于触发 <task-notification>）
  private completeCallbacks = new Map<string, DelegateCompleteCallback>()

  // 创建新的委派会话
  async create(adapter: ExternalAgentAdapter, task: DelegateTask): Promise<ExternalAgentSession> {
    const session = new ExternalAgentSession(adapter, task)
    this.sessions.set(session.id, session)

    // 设置完成回调
    session.setOnComplete((completedSession) => {
      const callback = this.completeCallbacks.get(completedSession.id)
      if (callback) {
        callback(completedSession)
        this.completeCallbacks.delete(completedSession.id)
      }
    })

    await session.start()
    return session
  }

  // 获取会话
  get(delegateId: string): ExternalAgentSession | undefined {
    return this.sessions.get(delegateId)
  }

  // 注册完成通知回调
  onComplete(delegateId: string, callback: DelegateCompleteCallback): void {
    this.completeCallbacks.set(delegateId, callback)
  }

  // 销毁单个会话
  async destroy(delegateId: string): Promise<void> {
    const session = this.sessions.get(delegateId)
    if (session) {
      await session.stop()
      this.sessions.delete(delegateId)
      this.completeCallbacks.delete(delegateId)
    }
  }

  // 清理所有会话（进程退出时调用）
  async destroyAll(): Promise<void> {
    const promises = Array.from(this.sessions.values()).map(session => session.stop())
    await Promise.allSettled(promises)
    this.sessions.clear()
    this.completeCallbacks.clear()
  }

  // 获取所有活跃会话数量
  getActiveCount(): number {
    return Array.from(this.sessions.values()).filter(s => s.status === 'running').length
  }
}

// 全局单例
export const ExternalAgentSessionManager = new ExternalAgentSessionManagerImpl()

// 优雅关闭时清理所有外部 Agent 子进程
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void ExternalAgentSessionManager.destroyAll()
  })
}
