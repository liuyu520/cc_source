import { useEffect, useState } from 'react'
import { getBranch, getIsGit } from '../utils/git.js'

// 轮询间隔：getBranch() 内部走 gitWatcher 缓存，miss 时才读磁盘，开销很低
const POLL_INTERVAL_MS = 5_000

/**
 * 订阅当前 git 分支名。
 * - 非 git 仓库返回 null
 * - 复用 utils/git.ts 里的 getBranch() / gitWatcher 缓存，避免重复 spawn
 * - 轻量轮询以响应外部分支切换（如用户在另一个终端 checkout）
 */
export function useGitBranch(): string | null {
  const [branch, setBranch] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    async function refresh() {
      try {
        const isGit = await getIsGit()
        if (cancelled) return
        if (!isGit) {
          setBranch(null)
          return
        }
        const next = await getBranch()
        if (cancelled) return
        setBranch(prev => (prev === next ? prev : next || null))
      } catch {
        // 读取失败时保持原值，避免闪烁
      }
    }

    function schedule() {
      timer = setTimeout(async () => {
        await refresh()
        if (!cancelled) schedule()
      }, POLL_INTERVAL_MS)
    }

    void refresh()
    schedule()

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [])

  return branch
}
