/**
 * SnapshotStore —— 通用快照落盘 / 回填工厂的对外出口。
 *
 * 使用示例:
 *   const store = createSnapshotStore({
 *     namespace: 'my-module',
 *     schemaVersion: 1,
 *     getSnapshot: () => myState,        // 当前数据(null = 跳过 save)
 *     applySnapshot: (data) => { myState = data },
 *   })
 *   await store.loadNow(projectDir)      // 冷启动回填
 *   setInterval(() => store.saveNow(projectDir), 60_000)  // 或走 periodicMaintenance
 *
 * /kernel-status 会自动列出每个 namespace 的 lastSaved / lastLoaded / bytes / error。
 */

export {
  createSnapshotStore,
  getAllSnapshotStores,
  getSnapshotStoreByNamespace,
  __resetSnapshotStoreRegistryForTests,
} from './snapshotStore.js'

export type {
  SnapshotStoreHandle,
  SnapshotStoreSnapshot,
  CreateSnapshotStoreOptions,
} from './snapshotStore.js'
