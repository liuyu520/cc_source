type RemoteSkillMeta = {
  slug: string
  url: string
}

const CANONICAL_PREFIX = '_canonical_'
const discoveredRemoteSkills = new Map<string, RemoteSkillMeta>()

export function getRemoteSkillState(): Map<string, RemoteSkillMeta> {
  return discoveredRemoteSkills
}

export function stripCanonicalPrefix(commandName: string): string | null {
  return commandName.startsWith(CANONICAL_PREFIX)
    ? commandName.slice(CANONICAL_PREFIX.length)
    : null
}

export function getDiscoveredRemoteSkill(
  slug: string,
): RemoteSkillMeta | null {
  return discoveredRemoteSkills.get(slug) ?? null
}

export function rememberDiscoveredRemoteSkills(
  skills: RemoteSkillMeta[],
): void {
  for (const skill of skills) {
    discoveredRemoteSkills.set(skill.slug, skill)
  }
}

export function clearRemoteSkillState(): void {
  discoveredRemoteSkills.clear()
}
