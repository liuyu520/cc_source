import { setMainLoopModelOverride } from '../bootstrap/state.js'
import { clearResolveCapabilitiesCache } from '../services/providers/resolveCapabilities.js'
import { BASH_TOOL_NAME } from '../tools/BashTool/toolName.js'
import {
  clearApiKeyHelperCache,
  clearAwsCredentialsCache,
  clearGcpCredentialsCache,
} from '../utils/auth.js'
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import { toError } from '../utils/errors.js'
import { logError } from '../utils/log.js'
import { logForDebugging } from '../utils/debug.js'
import { applyConfigEnvironmentVariables } from '../utils/managedEnv.js'
import {
  permissionModeFromString,
  toExternalPermissionMode,
} from '../utils/permissions/PermissionMode.js'
import {
  notifyPermissionModeChanged,
  notifySessionMetadataChanged,
  type SessionExternalMetadata,
} from '../utils/sessionState.js'
import { updateSettingsForSource } from '../utils/settings/settings.js'
import type { AppState } from './AppStateStore.js'
import { kernelDispatchUpdater } from './kernelDispatch.js'
import { scheduleAppStateUpdate } from './kernelFeedback.js'
import {
  failureCountByClassWithin,
  hasOpenHypothesis,
  rejectionCountWithin,
} from './kernelSelectors.js'

// Inverse of the push below — restore on worker restart.
export function externalMetadataToAppState(
  metadata: SessionExternalMetadata,
): (prev: AppState) => AppState {
  return prev => ({
    ...prev,
    ...(typeof metadata.permission_mode === 'string'
      ? {
          toolPermissionContext: {
            ...prev.toolPermissionContext,
            mode: permissionModeFromString(metadata.permission_mode),
          },
        }
      : {}),
    ...(typeof metadata.is_ultraplan_mode === 'boolean'
      ? { isUltraplanMode: metadata.is_ultraplan_mode }
      : {}),
  })
}

export function onChangeAppState({
  newState,
  oldState,
}: {
  newState: AppState
  oldState: AppState
}) {
  // toolPermissionContext.mode — single choke point for CCR/SDK mode sync.
  //
  // Prior to this block, mode changes were relayed to CCR by only 2 of 8+
  // mutation paths: a bespoke setAppState wrapper in print.ts (headless/SDK
  // mode only) and a manual notify in the set_permission_mode handler.
  // Every other path — Shift+Tab cycling, ExitPlanModePermissionRequest
  // dialog options, the /plan slash command, rewind, the REPL bridge's
  // onSetPermissionMode — mutated AppState without telling
  // CCR, leaving external_metadata.permission_mode stale and the web UI out
  // of sync with the CLI's actual mode.
  //
  // Hooking the diff here means ANY setAppState call that changes the mode
  // notifies CCR (via notifySessionMetadataChanged → ccrClient.reportMetadata)
  // and the SDK status stream (via notifyPermissionModeChanged → registered
  // in print.ts). The scattered callsites above need zero changes.
  const prevMode = oldState.toolPermissionContext.mode
  const newMode = newState.toolPermissionContext.mode
  if (prevMode !== newMode) {
    // CCR external_metadata must not receive internal-only mode names
    // (bubble, ungated auto). Externalize first — and skip
    // the CCR notify if the EXTERNAL mode didn't change (e.g.,
    // default→bubble→default is noise from CCR's POV since both
    // externalize to 'default'). The SDK channel (notifyPermissionModeChanged)
    // passes raw mode; its listener in print.ts applies its own filter.
    const prevExternal = toExternalPermissionMode(prevMode)
    const newExternal = toExternalPermissionMode(newMode)
    if (prevExternal !== newExternal) {
      // Ultraplan = first plan cycle only. The initial control_request
      // sets mode and isUltraplanMode atomically, so the flag's
      // transition gates it. null per RFC 7396 (removes the key).
      const isUltraplan =
        newExternal === 'plan' &&
        newState.isUltraplanMode &&
        !oldState.isUltraplanMode
          ? true
          : null
      notifySessionMetadataChanged({
        permission_mode: newExternal,
        is_ultraplan_mode: isUltraplan,
      })
    }
    notifyPermissionModeChanged(newMode)
  }

  // mainLoopModel: remove it from settings?
  if (
    newState.mainLoopModel !== oldState.mainLoopModel &&
    newState.mainLoopModel === null
  ) {
    // Remove from settings
    updateSettingsForSource('userSettings', { model: undefined })
    setMainLoopModelOverride(null)
  }

  // mainLoopModel: add it to settings?
  if (
    newState.mainLoopModel !== oldState.mainLoopModel &&
    newState.mainLoopModel !== null
  ) {
    // Save to settings
    updateSettingsForSource('userSettings', { model: newState.mainLoopModel })
    setMainLoopModelOverride(newState.mainLoopModel)
  }

  // expandedView → persist as showExpandedTodos + showSpinnerTree for backwards compat
  if (newState.expandedView !== oldState.expandedView) {
    const showExpandedTodos = newState.expandedView === 'tasks'
    const showSpinnerTree = newState.expandedView === 'teammates'
    if (
      getGlobalConfig().showExpandedTodos !== showExpandedTodos ||
      getGlobalConfig().showSpinnerTree !== showSpinnerTree
    ) {
      saveGlobalConfig(current => ({
        ...current,
        showExpandedTodos,
        showSpinnerTree,
      }))
    }
  }

  // verbose
  if (
    newState.verbose !== oldState.verbose &&
    getGlobalConfig().verbose !== newState.verbose
  ) {
    const verbose = newState.verbose
    saveGlobalConfig(current => ({
      ...current,
      verbose,
    }))
  }

  // tungstenPanelVisible (ant-only tmux panel sticky toggle)
  if (process.env.USER_TYPE === 'ant') {
    if (
      newState.tungstenPanelVisible !== oldState.tungstenPanelVisible &&
      newState.tungstenPanelVisible !== undefined &&
      getGlobalConfig().tungstenPanelVisible !== newState.tungstenPanelVisible
    ) {
      const tungstenPanelVisible = newState.tungstenPanelVisible
      saveGlobalConfig(current => ({ ...current, tungstenPanelVisible }))
    }
  }

  // settings: clear auth-related caches when settings change
  // This ensures apiKeyHelper and AWS/GCP credential changes take effect immediately
  if (newState.settings !== oldState.settings) {
    try {
      clearApiKeyHelperCache()
      clearAwsCredentialsCache()
      clearGcpCredentialsCache()
      // 当 settings 中的 providerCapabilities 配置变更时，清除能力解析缓存
      clearResolveCapabilitiesCache()

      // Re-apply environment variables when settings.env changes
      // This is additive-only: new vars are added, existing may be overwritten, nothing is deleted
      if (newState.settings.env !== oldState.settings.env) {
        applyConfigEnvironmentVariables()
      }
    } catch (error) {
      logError(toError(error))
    }
  }

  // ===========================================================================
  // KernelState 变更钩子 —— Phase 2 反馈回路接入点(Phase 1 保留空实现)
  // ---------------------------------------------------------------------------
  // 这里是把 "子系统 dispatch → kernel 变更 → 决策点副作用" 的回路物理接通的
  // 唯一集中位置。Phase 1 仅架构占位,不产生任何副作用,保证行为完全不变。
  //
  // Phase 2 将在这里按字段分支接入例如:
  //   - kernel.cost.monthUSD 超阈值 → 通知 modelRouter 降级
  //   - kernel.openHypotheses 新增   → 通知 intentRouter 降级同 tag 任务的 IntentClass
  //   - kernel.userRejections 新增   → 通知 executionMode 升级该 actionClass 的确认强度
  //   - kernel.compactBurst           → 通知 compact orchestrator 避免抖动
  //
  // 约束:这里的任何分支必须遵守——
  //   1. 只做"设置下一轮要用的标志位"或"计划轻量异步任务",禁止同步 I/O/API 调用
  //      (setState 回调是 hot path,任何阻塞都会波及 UI 响应);
  //   2. 必须先做引用相等短路(if (newState.kernel === oldState.kernel) return)。
  // ===========================================================================
  if (newState.kernel !== oldState.kernel) {
    // ---------- Phase 2 Shot 2 反馈回路:Bash 连拒 → 降级到 plan ----------
    // 最小学习规则(刻意简单):同一个 Bash 工具 60s 内被用户拒 ≥ 3 次 →
    // 下一次 Bash 请求前,把 toolPermissionContext.mode 切到 'plan'。
    //
    // 为什么是 plan 而不是其它降级:
    //   plan 模式让模型先"亮出计划"再执行,用户能直接看到下一步意图并纠偏。
    //   这是最轻量的干预 —— 不 block 模型,不改 prompt,只在权限层改变默认态。
    //
    // 约束遵循:
    //   1) 只有 userRejections 引用变了才有必要检查(reference 短路);
    //   2) 已经在 plan / auto 模式下就跳过 —— 不反复触发,也不覆盖用户手动选择;
    //   3) 写回用 scheduleAppStateUpdate(queueMicrotask),避免在 setState 栈内
    //      同步重入;
    //   4) 再次触发后,由于下一轮 userRejections 数组的"最后一条"还是同一条,
    //      我们用 `latest.ts` + `alreadyHandledRejectionTs` 做幂等(只响应
    //      第一次越过阈值那一条);
    //   5) 软信号语义:任何一步失败都不应抛出,保持 reducer 以外无副作用。
    if (newState.kernel.userRejections !== oldState.kernel.userRejections) {
      const list = newState.kernel.userRejections
      const latest = list.length > 0 ? list[list.length - 1] : null
      if (
        latest &&
        latest.actionClass === BASH_TOOL_NAME &&
        latest.ts !== lastHandledBashRejectTs
      ) {
        const count = rejectionCountWithin(
          newState,
          BASH_TOOL_NAME,
          BASH_REJECT_WINDOW_MS,
        )
        const currentMode = newState.toolPermissionContext.mode
        if (
          count >= BASH_REJECT_THRESHOLD &&
          currentMode !== 'plan' &&
          currentMode !== 'auto'
        ) {
          // 标记已处理,防止同一条 reject 触发多次调度。
          lastHandledBashRejectTs = latest.ts
          logForDebugging(
            `[kernel:feedback] Bash rejected ${count}× within ${BASH_REJECT_WINDOW_MS}ms — scheduling permissionMode → plan`,
          )
          scheduleAppStateUpdate(prev => {
            // 双重检查:异步跑到时用户可能已自己切过模式,尊重之。
            if (
              prev.toolPermissionContext.mode === 'plan' ||
              prev.toolPermissionContext.mode === 'auto'
            ) {
              return prev
            }
            return {
              ...prev,
              toolPermissionContext: {
                ...prev.toolPermissionContext,
                mode: 'plan',
              },
            }
          })
        }
      }
    }
    // 预留:Phase 2 更多子系统按字段分支接入,往下追加
    //   `if (newState.kernel.X !== oldState.kernel.X) { ... }` 即可,
    //   不需要修改外层结构。

    // ---------- Phase 2 Shot 4 反馈回路:tool+errorClass 连失败 → 自动开 RCA 假说 ----------
    // 规则(刻意简单):同一个 (tool, errorClass) 组合 5min 内 ≥3 次 →
    // 自动 rca:open 一条假说,id/tag = `${tool}:${errorClass}`。
    //
    // 为什么需要"自动开假说":
    //   openHypotheses 是"待调研线索"总线 —— intentRouter、modelRouter、UI 面板都会读。
    //   手工开不现实,必须从信号层自动升格。阈值 3 次:单次失败是噪声,连 3 次同类才是真线索。
    //
    // 约束遵循:
    //   1) 只有 recentFailures 引用变了才检查(reference 短路);
    //   2) 用 hasOpenHypothesis 做早期短路,避免重复调度;reducer 内 id 幂等作第二道闸;
    //   3) scheduleAppStateUpdate 微任务化,避免在 setState 栈内同步重入;
    //   4) 软信号:偶尔错失一条不影响正确性,无需时间戳哨兵 —— hasOpenHypothesis 足够。
    if (newState.kernel.recentFailures !== oldState.kernel.recentFailures) {
      const list = newState.kernel.recentFailures
      const latest = list.length > 0 ? list[list.length - 1] : null
      if (latest) {
        const tag = `${latest.tool}:${latest.errorClass}`
        if (!hasOpenHypothesis(newState, tag)) {
          const count = failureCountByClassWithin(
            newState,
            latest.tool,
            latest.errorClass,
            FAILURE_RCA_WINDOW_MS,
          )
          if (count >= FAILURE_RCA_THRESHOLD) {
            // severity 分级:3 → 1, 6 → 2, 9+ → 3(一次性锁定,reducer id 幂等后无法升级)
            const sev: 1 | 2 | 3 = count >= 9 ? 3 : count >= 6 ? 2 : 1
            logForDebugging(
              `[kernel:feedback] ${tag} failed ${count}× within ${FAILURE_RCA_WINDOW_MS}ms — opening RCA hypothesis (sev ${sev})`,
            )
            scheduleAppStateUpdate(
              kernelDispatchUpdater({
                type: 'rca:open',
                hypothesis: {
                  id: tag, // id = tag 保证每类只一条;reducer 本身也做 id 去重
                  tag,
                  severity: sev,
                },
              }),
            )
          }
        }
      }
    }
  }
}

// ----- Phase 2 反馈回路常量与模块级去重 -----
const BASH_REJECT_WINDOW_MS = 60_000
const BASH_REJECT_THRESHOLD = 3
// 幂等哨兵:同一条 reject 记录不触发多次 plan 切换。
// 模块级(非 AppState)刻意而为 —— 这个"已处理水位线"不属于业务状态,
// 仅服务 onChangeAppState 自身的反抖动,不需要持久化,也不应在 /rewind 中回滚。
let lastHandledBashRejectTs = 0

// Shot 4:失败→RCA 的窗口与阈值。故意比 Bash 连拒窗口大(失败通常间隔更长)。
const FAILURE_RCA_WINDOW_MS = 5 * 60_000
const FAILURE_RCA_THRESHOLD = 3
