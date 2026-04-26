import type { EffortLevel } from '../../../../utils/effort.js'

export type CodexModelOption = {
  value: string
  label: string
  description: string
  defaultEffort?: Extract<EffortLevel, 'low' | 'medium' | 'high' | 'xhigh'>
}

export const CODEX_DEFAULT_MODEL = 'gpt-5.4'

export const CODEX_MODEL_OPTIONS: readonly CodexModelOption[] = [
  {
    value: 'gpt-5.4',
    label: 'gpt-5.4',
    description: 'Strong model for everyday coding.',
    defaultEffort: 'medium',
  },
  {
    value: 'gpt-5.5',
    label: 'gpt-5.5',
    description: 'Frontier model for complex coding, research, and real-world work.',
    defaultEffort: 'medium',
  },
  {
    value: 'gpt-5.4-mini',
    label: 'gpt-5.4-mini',
    description: 'Small, fast, and cost-efficient model for simpler coding tasks.',
    defaultEffort: 'medium',
  },
  {
    value: 'gpt-5.3-codex',
    label: 'gpt-5.3-codex',
    description: 'Coding-optimized model.',
    defaultEffort: 'medium',
  },
  {
    value: 'gpt-5.3-codex-spark',
    label: 'gpt-5.3-codex-spark',
    description: 'Ultra-fast coding model.',
    defaultEffort: 'high',
  },
  {
    value: 'gpt-5.2',
    label: 'gpt-5.2',
    description: 'Optimized for professional work and long-running agents.',
    defaultEffort: 'medium',
  },
] as const

const CODEX_REASONING_MODEL_PATTERNS = [
  /^gpt-5(?:[.-]|$)/,
  /^o[1-9](?:[.-]|$)/,
]

export function normalizeCodexModelName(model: string): string {
  return model.trim().replace(/^openai\//i, '')
}

export function getCodexModelOption(model: string): CodexModelOption | undefined {
  const normalized = normalizeCodexModelName(model)
  return CODEX_MODEL_OPTIONS.find(opt => opt.value === normalized)
}

export function isKnownCodexModel(model: string): boolean {
  return getCodexModelOption(model) !== undefined
}

export function isCodexReasoningModel(model: string): boolean {
  const normalized = normalizeCodexModelName(model).toLowerCase()
  return CODEX_REASONING_MODEL_PATTERNS.some(pattern => pattern.test(normalized))
}

export function getDefaultEffortForCodexModel(
  model: string,
): Extract<EffortLevel, 'low' | 'medium' | 'high' | 'xhigh'> {
  return getCodexModelOption(model)?.defaultEffort ?? 'medium'
}
