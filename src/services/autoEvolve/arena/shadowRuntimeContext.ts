import { getEmptyToolPermissionContext, type ToolUseContext, type Tools } from '../../../Tool.js'
import { getAllBaseTools } from '../../../tools.js'
import { createFileStateCacheWithSizeLimit } from '../../../utils/fileStateCache.js'
import type { AgentDefinitionsResult } from '../../../tools/AgentTool/loadAgentsDir.js'
import type { ThinkingConfig } from '../../../utils/thinking.js'

const SHADOW_RUNTIME_MODEL = 'shadow-runtime-guard'
const SHADOW_RUNTIME_THINKING: ThinkingConfig = { type: 'disabled' }
const SHADOW_RUNTIME_AGENTS: AgentDefinitionsResult = {
  activeAgents: [],
  allAgents: [],
}

let cachedRuntimeTools: Tools | null = null

export function getShadowRuntimeTools(): Tools {
  if (!cachedRuntimeTools) {
    cachedRuntimeTools = getAllBaseTools()
  }
  return cachedRuntimeTools
}

export function createShadowRuntimeToolUseContext(): ToolUseContext {
  const runtimeTools = getShadowRuntimeTools()
  const appState = {
    toolPermissionContext: getEmptyToolPermissionContext(),
    kernel: { openHypotheses: [] },
  }

  return {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: SHADOW_RUNTIME_MODEL,
      tools: runtimeTools,
      verbose: false,
      thinkingConfig: SHADOW_RUNTIME_THINKING,
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      agentDefinitions: SHADOW_RUNTIME_AGENTS,
    },
    abortController: new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(8),
    getAppState: () => appState as never,
    setAppState: () => {},
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => 0,
    updateFileHistoryState: prev => prev,
    updateAttributionState: prev => prev,
    messages: [],
  }
}
