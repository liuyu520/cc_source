// daemon worker 注册分发器
// cli.tsx:100-106 的 --daemon-worker fast-path 动态 import 此文件
export async function runDaemonWorker(kind: string): Promise<void> {
  switch (kind) {
    case 'http-server': {
      const { runHttpServerWorker } = await import(
        '../services/httpServer/workerEntry.js'
      )
      return runHttpServerWorker()
    }
    default:
      throw new Error(`unknown daemon worker kind: ${kind}`)
  }
}
