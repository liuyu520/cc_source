import { isEnvDefinedFalsy, isEnvTruthy } from '../../utils/envUtils.js'

export function isSkillSearchEnabled(): boolean {
  const envOverride = process.env.CLAUDE_CODE_ENABLE_SKILL_SEARCH
  if (isEnvDefinedFalsy(envOverride)) {
    return false
  }
  if (isEnvTruthy(envOverride)) {
    return true
  }

  if (isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)) {
    return false
  }
  if (isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS)) {
    return false
  }

  return true
}
