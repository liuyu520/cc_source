import React from 'react';
import type { StatsStore } from './context/stats.js';
import type { Root } from './ink.js';
import type { Props as REPLProps } from './screens/REPL.js';
import type { AppState } from './state/AppStateStore.js';
import type { FpsMetrics } from './utils/fpsTracker.js';
type AppWrapperProps = {
  getFpsMetrics: () => FpsMetrics | undefined;
  stats?: StatsStore;
  initialState: AppState;
};
export async function launchRepl(root: Root, appProps: AppWrapperProps, replProps: REPLProps, renderAndRun: (root: Root, element: React.ReactNode) => Promise<void>): Promise<void> {
  const {
    App
  } = await import('./components/App.js');
  const {
    REPL
  } = await import('./screens/REPL.js');

  // P1 Round2: 启动 agentScheduler 后台驱动(周期刷新 stats + 自适应配额)
  // fire-and-forget,错误吞掉,不影响 REPL 渲染/进程退出
  // 只在完整 REPL 启动路径触发;非交互/MCP 模式不走 launchRepl,不会启动
  //
  // 修复(2026-04-23):原来的 `(getMemoryPath as () => string)()` 是源码恢复时
  //   的类型 cast 错误 —— getMemoryPath 需要 MemoryType 参数,无参调用 fallthrough
  //   到末尾 return ''。空串进 startAgentSchedulerBackground 后第一行 `if (!projectDir)
  //   return` 即 early-return,导致 toolStats/agentStats 持久化、scheduler 自适应、
  //   cache-evict、speculation、shadow-agent、cold-start 共 7 个周期任务全未启动。
  //   这正是 Phase 45 挖矿基建拿不到真实数据的根因。改用 getProjectDir(cwd)
  //   —— 与 autoDream / memory / episodes 同一 project-level 根,snapshotStore
  //   的 `<projectDir>/snapshots/<ns>.json` 注释也是对齐这个级别。
  void (async () => {
    try {
      const { startAgentSchedulerBackground } = await import(
        './services/agentScheduler/index.js'
      );
      const { getProjectDir } = await import(
        './utils/sessionStoragePortable.js'
      );
      const { getOriginalCwd } = await import('./bootstrap/state.js');
      const projectDir = getProjectDir(getOriginalCwd());
      if (projectDir) {
        startAgentSchedulerBackground(projectDir);
      }
    } catch {
      // 启动失败不影响主流程
    }
  })();

  await renderAndRun(root, <App {...appProps}>
      <REPL {...replProps} />
    </App>);
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsIlN0YXRzU3RvcmUiLCJSb290IiwiUHJvcHMiLCJSRVBMUHJvcHMiLCJBcHBTdGF0ZSIsIkZwc01ldHJpY3MiLCJBcHBXcmFwcGVyUHJvcHMiLCJnZXRGcHNNZXRyaWNzIiwic3RhdHMiLCJpbml0aWFsU3RhdGUiLCJsYXVuY2hSZXBsIiwicm9vdCIsImFwcFByb3BzIiwicmVwbFByb3BzIiwicmVuZGVyQW5kUnVuIiwiZWxlbWVudCIsIlJlYWN0Tm9kZSIsIlByb21pc2UiLCJBcHAiLCJSRVBMIl0sInNvdXJjZXMiOlsicmVwbExhdW5jaGVyLnRzeCJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgUmVhY3QgZnJvbSAncmVhY3QnXG5pbXBvcnQgdHlwZSB7IFN0YXRzU3RvcmUgfSBmcm9tICcuL2NvbnRleHQvc3RhdHMuanMnXG5pbXBvcnQgdHlwZSB7IFJvb3QgfSBmcm9tICcuL2luay5qcydcbmltcG9ydCB0eXBlIHsgUHJvcHMgYXMgUkVQTFByb3BzIH0gZnJvbSAnLi9zY3JlZW5zL1JFUEwuanMnXG5pbXBvcnQgdHlwZSB7IEFwcFN0YXRlIH0gZnJvbSAnLi9zdGF0ZS9BcHBTdGF0ZVN0b3JlLmpzJ1xuaW1wb3J0IHR5cGUgeyBGcHNNZXRyaWNzIH0gZnJvbSAnLi91dGlscy9mcHNUcmFja2VyLmpzJ1xuXG50eXBlIEFwcFdyYXBwZXJQcm9wcyA9IHtcbiAgZ2V0RnBzTWV0cmljczogKCkgPT4gRnBzTWV0cmljcyB8IHVuZGVmaW5lZFxuICBzdGF0cz86IFN0YXRzU3RvcmVcbiAgaW5pdGlhbFN0YXRlOiBBcHBTdGF0ZVxufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbGF1bmNoUmVwbChcbiAgcm9vdDogUm9vdCxcbiAgYXBwUHJvcHM6IEFwcFdyYXBwZXJQcm9wcyxcbiAgcmVwbFByb3BzOiBSRVBMUHJvcHMsXG4gIHJlbmRlckFuZFJ1bjogKHJvb3Q6IFJvb3QsIGVsZW1lbnQ6IFJlYWN0LlJlYWN0Tm9kZSkgPT4gUHJvbWlzZTx2b2lkPixcbik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCB7IEFwcCB9ID0gYXdhaXQgaW1wb3J0KCcuL2NvbXBvbmVudHMvQXBwLmpzJylcbiAgY29uc3QgeyBSRVBMIH0gPSBhd2FpdCBpbXBvcnQoJy4vc2NyZWVucy9SRVBMLmpzJylcbiAgYXdhaXQgcmVuZGVyQW5kUnVuKFxuICAgIHJvb3QsXG4gICAgPEFwcCB7Li4uYXBwUHJvcHN9PlxuICAgICAgPFJFUEwgey4uLnJlcGxQcm9wc30gLz5cbiAgICA8L0FwcD4sXG4gIClcbn1cbiJdLCJtYXBwaW5ncyI6IkFBQUEsT0FBT0EsS0FBSyxNQUFNLE9BQU87QUFDekIsY0FBY0MsVUFBVSxRQUFRLG9CQUFvQjtBQUNwRCxjQUFjQyxJQUFJLFFBQVEsVUFBVTtBQUNwQyxjQUFjQyxLQUFLLElBQUlDLFNBQVMsUUFBUSxtQkFBbUI7QUFDM0QsY0FBY0MsUUFBUSxRQUFRLDBCQUEwQjtBQUN4RCxjQUFjQyxVQUFVLFFBQVEsdUJBQXVCO0FBRXZELEtBQUtDLGVBQWUsR0FBRztFQUNyQkMsYUFBYSxFQUFFLEdBQUcsR0FBR0YsVUFBVSxHQUFHLFNBQVM7RUFDM0NHLEtBQUssQ0FBQyxFQUFFUixVQUFVO0VBQ2xCUyxZQUFZLEVBQUVMLFFBQVE7QUFDeEIsQ0FBQztBQUVELE9BQU8sZUFBZU0sVUFBVUEsQ0FDOUJDLElBQUksRUFBRVYsSUFBSSxFQUNWVyxRQUFRLEVBQUVOLGVBQWUsRUFDekJPLFNBQVMsRUFBRVYsU0FBUyxFQUNwQlcsWUFBWSxFQUFFLENBQUNILElBQUksRUFBRVYsSUFBSSxFQUFFYyxPQUFPLEVBQUVoQixLQUFLLENBQUNpQixTQUFTLEVBQUUsR0FBR0MsT0FBTyxDQUFDLElBQUksQ0FBQyxDQUN0RSxFQUFFQSxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUM7RUFDZixNQUFNO0lBQUVDO0VBQUksQ0FBQyxHQUFHLE1BQU0sTUFBTSxDQUFDLHFCQUFxQixDQUFDO0VBQ25ELE1BQU07SUFBRUM7RUFBSyxDQUFDLEdBQUcsTUFBTSxNQUFNLENBQUMsbUJBQW1CLENBQUM7RUFDbEQsTUFBTUwsWUFBWSxDQUNoQkgsSUFBSSxFQUNKLENBQUMsR0FBRyxDQUFDLElBQUlDLFFBQVEsQ0FBQztBQUN0QixNQUFNLENBQUMsSUFBSSxDQUFDLElBQUlDLFNBQVMsQ0FBQztBQUMxQixJQUFJLEVBQUUsR0FBRyxDQUNQLENBQUM7QUFDSCIsImlnbm9yZUxpc3QiOltdfQ==