import { describe, expect, test } from 'bun:test'
import { createSkillCommand } from './loadSkillsDir.js'

describe('createSkillCommand', () => {
  test('preserves workflow fields for project skills', () => {
    const cmd = createSkillCommand({
      skillName: 'claude-version-bump-reuse',
      displayName: undefined,
      description: 'Version bump helper',
      hasUserSpecifiedDescription: true,
      markdownContent: '# Version bump helper',
      allowedTools: [],
      argumentHint: undefined,
      argumentNames: [],
      whenToUse: undefined,
      version: undefined,
      model: undefined,
      disableModelInvocation: false,
      userInvocable: true,
      source: 'projectSettings',
      baseDir: '.claude/skills/claude-version-bump-reuse',
      loadedFrom: 'skills',
      hooks: undefined,
      executionContext: undefined,
      agent: undefined,
      paths: undefined,
      effort: undefined,
      shell: undefined,
      next: ['sync-docs'],
      depends: ['bump-package-version'],
      workflowGroup: 'versioning',
    })

    expect(cmd.next).toEqual(['sync-docs'])
    expect(cmd.depends).toEqual(['bump-package-version'])
    expect(cmd.workflowGroup).toBe('versioning')
  })
})
