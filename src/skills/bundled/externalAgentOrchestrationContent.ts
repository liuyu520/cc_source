// Content for the external-agent-orchestration bundled skill.
// Each .md file is inlined as a string at build time via Bun's text loader.

import pipelineSpecMd from './external-agent-orchestration/examples/pipeline-spec.md'
import shadowReuseMd from './external-agent-orchestration/examples/shadow-reuse.md'
import skillMd from './external-agent-orchestration/SKILL.md'

export const SKILL_MD: string = skillMd

export const SKILL_FILES: Record<string, string> = {
  'examples/pipeline-spec.md': pipelineSpecMd,
  'examples/shadow-reuse.md': shadowReuseMd,
}
