// src/services/skillSearch/contextScoring.ts
// 上下文维度评分：文件类型亲和度、工具使用模式、使用历史

import { getSkillUsageScore } from '../../utils/suggestions/skillUsageTracking.js'

type ScoredSkill = {
  name: string
  normalizedName: string
  normalizedDescription: string
  normalizedWhenToUse: string
}

// 文件扩展名 → 相关skill关键词
const FILE_TYPE_SKILL_AFFINITY: Record<string, string[]> = {
  '.tsx':    ['frontend', 'component', 'ui', 'react', 'design'],
  '.jsx':    ['frontend', 'component', 'ui', 'react', 'design'],
  '.css':    ['frontend', 'style', 'design', 'theme'],
  '.scss':   ['frontend', 'style', 'design', 'theme'],
  '.vue':    ['frontend', 'component', 'vue', 'design'],
  '.svelte': ['frontend', 'component', 'svelte', 'design'],
  '.py':     ['python', 'backend', 'api', 'script'],
  '.go':     ['backend', 'api', 'server'],
  '.rs':     ['backend', 'rust', 'system'],
  '.java':   ['backend', 'api', 'spring'],
  '.sql':    ['database', 'migration', 'query'],
  '.prisma': ['database', 'schema', 'migration'],
  '.proto':  ['api', 'grpc', 'protocol'],
  '.yaml':   ['config', 'deploy', 'ci'],
  '.yml':    ['config', 'deploy', 'ci'],
  '.docker': ['deploy', 'container', 'docker'],
}

// 特殊文件名模式（用 includes 匹配）
const FILE_PATTERN_SKILL_AFFINITY: [string, string[]][] = [
  ['.test.',  ['test', 'tdd', 'verify']],
  ['.spec.',  ['test', 'tdd', 'verify']],
  ['__test',  ['test', 'tdd', 'verify']],
  ['_test.',  ['test', 'tdd', 'verify']],
]

// 工具名 → 相关skill关键词
const TOOL_PATTERN_AFFINITY: Record<string, string[]> = {
  'Bash':           ['debug', 'verify', 'deploy', 'script'],
  'Edit':           ['refactor', 'fix', 'implement', 'cleanup'],
  'Write':          ['create', 'scaffold', 'new'],
  'Agent':          ['plan', 'architect', 'parallel', 'dispatch'],
  'Grep':           ['debug', 'explore', 'search', 'find'],
  'Read':           ['explore', 'understand', 'review'],
  'Glob':           ['explore', 'find', 'search'],
}

/**
 * 计算上下文维度评分
 * 综合文件类型亲和度、工具使用模式、使用历史三个子维度
 */
export function computeContextScore(
  skill: ScoredSkill,
  activeFileExtensions: string[],
  recentTools: string[],
): number {
  let score = 0

  // 文件类型亲和度：精确扩展名匹配
  for (const ext of activeFileExtensions) {
    const affinityTerms = FILE_TYPE_SKILL_AFFINITY[ext]
    if (affinityTerms) {
      for (const term of affinityTerms) {
        if (skill.normalizedDescription.includes(term) ||
            skill.normalizedName.includes(term) ||
            skill.normalizedWhenToUse.includes(term)) {
          score += 15
        }
      }
    }
  }

  // 文件名模式匹配（.test. / .spec. 等）
  for (const ext of activeFileExtensions) {
    for (const [pattern, terms] of FILE_PATTERN_SKILL_AFFINITY) {
      if (ext.includes(pattern)) {
        for (const term of terms) {
          if (skill.normalizedDescription.includes(term) ||
              skill.normalizedName.includes(term)) {
            score += 15
          }
        }
      }
    }
  }

  // 工具使用模式亲和度
  for (const tool of recentTools) {
    const affinityTerms = TOOL_PATTERN_AFFINITY[tool]
    if (affinityTerms) {
      for (const term of affinityTerms) {
        if (skill.normalizedDescription.includes(term) ||
            skill.normalizedName.includes(term)) {
          score += 10
        }
      }
    }
  }

  // 使用历史加权（复用现有skillUsageTracking的指数衰减评分）
  const usageScore = getSkillUsageScore(skill.name)
  if (usageScore > 0) {
    score += usageScore * 5
  }

  return score
}
