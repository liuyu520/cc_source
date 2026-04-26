// Content for the shadow-cutover bundled skill.
// Each .md file is inlined as a string at build time via Bun's text loader.

import compactOrchestratorMd from './shadow-cutover/examples/compact-orchestrator.md'
import providerRegistryMd from './shadow-cutover/examples/provider-registry.md'
import pevHarnessMd from './shadow-cutover/examples/pev-harness.md'
import dreamPipelineMd from './shadow-cutover/examples/dream-pipeline.md'
import intentRouterMd from './shadow-cutover/examples/intent-router.md'
import costConsumerLoopMd from './shadow-cutover/examples/cost-consumer-loop.md'
import skillMd from './shadow-cutover/SKILL.md'

export const SKILL_MD: string = skillMd

export const SKILL_FILES: Record<string, string> = {
  'examples/compact-orchestrator.md': compactOrchestratorMd,
  'examples/provider-registry.md': providerRegistryMd,
  'examples/pev-harness.md': pevHarnessMd,
  'examples/dream-pipeline.md': dreamPipelineMd,
  'examples/intent-router.md': intentRouterMd,
  'examples/cost-consumer-loop.md': costConsumerLoopMd,
}
