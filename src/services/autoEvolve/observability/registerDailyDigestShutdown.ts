/**
 * self-evolution-kernel v1.0 §6.3 observability — graceful-shutdown 兜底。
 *
 * 目标:用户关 CLI 时,自动把"今天这一天"的 autoEvolve 活动落一份 markdown
 * 摘要到 ~/.claude/autoEvolve/daily-digest/<YYYY-MM-DD>.md。用户不必手动
 * 记得跑 /evolve-daily-digest --apply。
 *
 * 设计纪律:
 *   - 幂等:writeDailyDigest 内部 writeFileSync 按 UTC 日期覆盖,同日重启
 *     不会追加重复。
 *   - 零阻塞:registerCleanup 返回 Promise<void>,这里同步 writeFileSync
 *     但内部自己 catch,整条路径静默。
 *   - fail-open:异常只打 debug log,绝不让 shutdown 卡住或抛错。
 *   - opt-out:CLAUDE_EVOLVE=off 时完全跳过注册(与 autoEvolve 全局开关
 *     保持一致)。
 *   - 只注册一次:内部 registered flag 防重复挂钩(query loop 可能被多次
 *     冷启动)。
 *
 * 调用时机:与 registerRCAHook() 并排,由 query.ts 的主循环入口触发。
 */

import { registerCleanup } from '../../../utils/cleanupRegistry.js'
import { logForDebugging } from '../../../utils/debug.js'

let registered = false

export function registerDailyDigestShutdown(): void {
  if (registered) return
  registered = true

  // 与 autoEvolve 全局开关一致:off 时退出,其他值(含 undefined)默认开。
  if (process.env.CLAUDE_EVOLVE === 'off') {
    logForDebugging('[dailyDigest] skipped by CLAUDE_EVOLVE=off')
    return
  }

  registerCleanup(async () => {
    try {
      // 懒加载,避免在启动期触发 autoEvolve 子系统的 side effect
      const { writeDailyDigest } = await import('./dailyDigest.js')
      const result = writeDailyDigest()
      logForDebugging(
        `[dailyDigest] shutdown write: path=${result.path} bytes=${result.bytes} overwrote=${result.overwrote}`,
      )
    } catch (e) {
      logForDebugging(
        `[dailyDigest] shutdown write failed: ${(e as Error).message}`,
      )
    }
  })
}
