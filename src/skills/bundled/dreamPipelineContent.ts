// Content for the dream-pipeline bundled skill.
// Each .md file is inlined as a string at build time via Bun's text loader.

import evidenceCaptureMd from './dream-pipeline/examples/evidence-capture.md'
import learnedWeightsMd from './dream-pipeline/examples/learned-weights.md'
import graphConceptSignalsMd from './dream-pipeline/examples/graph-concept-signals.md'
import graphWritebackNoveltyDedupMd from './dream-pipeline/examples/graph-writeback-novelty-dedup.md'
import memoryMapObservabilityMd from './dream-pipeline/examples/memory-map-observability.md'
import skillMd from './dream-pipeline/SKILL.md'

export const SKILL_MD: string = skillMd

export const SKILL_FILES: Record<string, string> = {
  'examples/evidence-capture.md': evidenceCaptureMd,
  'examples/learned-weights.md': learnedWeightsMd,
  'examples/graph-concept-signals.md': graphConceptSignalsMd,
  'examples/graph-writeback-novelty-dedup.md': graphWritebackNoveltyDedupMd,
  'examples/memory-map-observability.md': memoryMapObservabilityMd,
}
