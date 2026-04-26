import type { Message } from '../../types/message.js'

type CompactBoundaryWithSkills = {
  compactMetadata?: {
    preCompactDiscoveredSkills?: unknown
  }
}

type SkillAttachmentWithNames = {
  type?: unknown
  skills?: Array<{
    name?: unknown
  }>
}

export function addDiscoveredSkillNames(
  target: Set<string> | undefined,
  skillNames: Iterable<string>,
): void {
  if (!target) {
    return
  }

  for (const skillName of skillNames) {
    if (skillName) {
      target.add(skillName)
    }
  }
}

export function extractDiscoveredSkillNames(
  messages: ReadonlyArray<Message> | undefined,
): Set<string> {
  const discoveredSkills = new Set<string>()

  if (!messages) {
    return discoveredSkills
  }

  for (const message of messages) {
    if (message.type === 'system' && message.subtype === 'compact_boundary') {
      const carried = (message as Message & CompactBoundaryWithSkills)
        .compactMetadata?.preCompactDiscoveredSkills
      if (Array.isArray(carried)) {
        for (const skillName of carried) {
          if (typeof skillName === 'string' && skillName) {
            discoveredSkills.add(skillName)
          }
        }
      }
      continue
    }

    if (message.type !== 'attachment' || !('attachment' in message)) {
      continue
    }

    const attachment = (
      message as Message & {
        attachment?: SkillAttachmentWithNames
      }
    ).attachment
    if (!attachment) {
      continue
    }

    if (
      attachment.type !== 'skill_discovery' &&
      attachment.type !== 'invoked_skills'
    ) {
      continue
    }

    if (!Array.isArray(attachment.skills)) {
      continue
    }

    for (const skill of attachment.skills) {
      if (typeof skill?.name === 'string' && skill.name) {
        discoveredSkills.add(skill.name)
      }
    }
  }

  return discoveredSkills
}
