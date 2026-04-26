import * as React from 'react'
import { useMemo, useState } from 'react'
import { Box, Text } from '../ink.js'
import { useKeybindings } from '../keybindings/useKeybinding.js'
import { useSetAppState } from '../state/AppState.js'
import type { EffortLevel } from '../utils/effort.js'
import {
  getCodexConfiguredModel,
  getCodexConfiguredReasoningEffort,
  saveCodexModelSelection,
  type CodexReasoningEffort,
} from '../services/providers/impls/codex/auth.js'
import {
  CODEX_DEFAULT_MODEL,
  CODEX_MODEL_OPTIONS,
  getDefaultEffortForCodexModel,
  normalizeCodexModelName,
} from '../services/providers/impls/codex/models.js'
import { Select } from './CustomSelect/index.js'
import { Pane } from './design-system/Pane.js'
import { effortLevelToSymbol } from './EffortIndicator.js'

type Props = {
  onDone: (result?: string, options?: { display?: 'system' }) => void
  isStandaloneCommand?: boolean
}

type SelectOption = {
  value: string
  label: string
  description: string
}

const CODEX_EFFORT_LEVELS: readonly CodexReasoningEffort[] = [
  'low',
  'medium',
  'high',
  'xhigh',
]

export function CodexModelPicker({
  onDone,
  isStandaloneCommand,
}: Props): React.ReactNode {
  const configuredModel = getCodexConfiguredModel()
  const currentModel = normalizeCodexModelName(configuredModel)
  const configuredEffort = getCodexConfiguredReasoningEffort()
  const [focusedModel, setFocusedModel] = useState(currentModel)
  const [effort, setEffort] = useState<CodexReasoningEffort>(
    configuredEffort ?? getDefaultEffortForCodexModel(currentModel),
  )
  const [hasToggledEffort, setHasToggledEffort] = useState(false)
  const setAppState = useSetAppState()

  const options = useMemo<SelectOption[]>(() => {
    const base = CODEX_MODEL_OPTIONS.map(opt => ({
      value: opt.value,
      label: opt.value === currentModel ? `${opt.label} (current)` : opt.label,
      description: opt.description,
    }))
    if (!base.some(opt => opt.value === currentModel)) {
      return [
        {
          value: currentModel,
          label: `${configuredModel} (current)`,
          description: 'Custom Codex model from config.toml',
        },
        ...base,
      ]
    }
    return base
  }, [configuredModel, currentModel])

  const handleFocus = (value: string): void => {
    setFocusedModel(value)
    if (!hasToggledEffort && configuredEffort === undefined) {
      setEffort(getDefaultEffortForCodexModel(value))
    }
  }

  const handleCycleEffort = (direction: 'left' | 'right'): void => {
    setEffort(prev => cycleCodexEffort(prev, direction))
    setHasToggledEffort(true)
  }

  useKeybindings(
    {
      'modelPicker:decreaseEffort': () => handleCycleEffort('left'),
      'modelPicker:increaseEffort': () => handleCycleEffort('right'),
    },
    { context: 'CodexModelPicker' },
  )

  const handleSelect = (model: string): void => {
    saveCodexModelSelection({ model, reasoningEffort: effort })
    setAppState(prev => ({
      ...prev,
      mainLoopModel: model,
      mainLoopModelForSession: null,
      effortValue: effort,
    }))
    onDone(`Set Codex model to ${model} with ${effort} effort`)
  }

  const handleCancel = (): void => {
    onDone(`Kept Codex model as ${configuredModel}`, { display: 'system' })
  }

  const content = (
    <Box flexDirection="column">
      <Box marginBottom={1} flexDirection="column">
        <Text color="remember" bold>
          Select Model and Effort
        </Text>
        <Text dimColor>
          Access legacy models by running codex -m &lt;model_name&gt; or in your
          config.toml
        </Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Select
          defaultValue={currentModel}
          defaultFocusValue={focusedModel}
          options={options}
          onChange={handleSelect}
          onFocus={handleFocus}
          onCancel={handleCancel}
          visibleOptionCount={Math.min(10, options.length)}
        />
      </Box>

      <Box marginBottom={1}>
        <Text dimColor>
          <Text color="claude">{effortLevelToSymbol(effort)}</Text>{' '}
          {formatEffort(effort)} effort{' '}
          <Text color="subtle">← → to adjust</Text>
        </Text>
      </Box>
    </Box>
  )

  return isStandaloneCommand ? <Pane color="permission">{content}</Pane> : content
}

export function setCodexModelInline(model: string): {
  model: string
  effort: CodexReasoningEffort
  message: string
} {
  const normalized = normalizeCodexModelName(
    model === 'default' ? CODEX_DEFAULT_MODEL : model,
  )
  const effort =
    getCodexConfiguredReasoningEffort() ?? getDefaultEffortForCodexModel(normalized)
  saveCodexModelSelection({ model: normalized, reasoningEffort: effort })
  return {
    model: normalized,
    effort,
    message: `Set Codex model to ${normalized} with ${effort} effort`,
  }
}

export function getCodexModelStatus(): string {
  const model = getCodexConfiguredModel()
  const effort = getCodexConfiguredReasoningEffort()
  return `Current Codex model: ${model}${effort ? ` (effort: ${effort})` : ''}`
}

function cycleCodexEffort(
  current: CodexReasoningEffort,
  direction: 'left' | 'right',
): CodexReasoningEffort {
  const idx = CODEX_EFFORT_LEVELS.indexOf(current)
  const currentIndex = idx === -1 ? CODEX_EFFORT_LEVELS.indexOf('medium') : idx
  if (direction === 'right') {
    return CODEX_EFFORT_LEVELS[
      (currentIndex + 1) % CODEX_EFFORT_LEVELS.length
    ]!
  }
  return CODEX_EFFORT_LEVELS[
    (currentIndex - 1 + CODEX_EFFORT_LEVELS.length) %
      CODEX_EFFORT_LEVELS.length
  ]!
}

function formatEffort(effort: EffortLevel): string {
  return effort === 'xhigh' ? 'XHigh' : effort[0]!.toUpperCase() + effort.slice(1)
}
