// src/services/skillSearch/skillWorkflows.ts
// 预定义的skill工作流编排模式

export type WorkflowStep = {
  label: string
  skills: string[]
  optional?: boolean
  condition?: string
}

export type SkillWorkflow = {
  id: string
  name: string
  description: string
  steps: WorkflowStep[]
  triggers: string[]
}

export const BUILTIN_WORKFLOWS: SkillWorkflow[] = [
  {
    id: 'feature-dev',
    name: '功能开发',
    description: '从需求到实现的完整功能开发流程',
    triggers: [
      'implement', 'build', 'create', 'add feature', 'new feature',
      '实现', '开发', '新功能', '添加功能', '构建',
    ],
    steps: [
      { label: '需求分析', skills: ['superpowers:brainstorming', 'brainstorming'] },
      { label: '实施规划', skills: ['superpowers:writing-plans', 'writing-plans'] },
      {
        label: '测试驱动开发',
        skills: ['superpowers:test-driven-development', 'test-driven-development'],
        optional: true,
        condition: '如果项目有测试框架',
      },
      {
        label: '并行执行',
        skills: [
          'superpowers:dispatching-parallel-agents',
          'superpowers:executing-plans',
          'dispatching-parallel-agents',
          'executing-plans',
        ],
      },
      { label: '代码审查', skills: ['superpowers:requesting-code-review', 'requesting-code-review'] },
      { label: '验证完成', skills: ['superpowers:verification-before-completion', 'verification-before-completion'] },
      {
        label: '分支收尾',
        skills: ['superpowers:finishing-a-development-branch', 'finishing-a-development-branch'],
      },
    ],
  },
  {
    id: 'bugfix',
    name: 'Bug修复',
    description: '系统化的bug调试和修复流程',
    triggers: [
      'fix', 'bug', 'debug', 'error', 'broken', 'crash',
      '修复', '调试', 'bug', '错误', '崩溃', '排错',
    ],
    steps: [
      { label: '系统调试', skills: ['superpowers:systematic-debugging', 'systematic-debugging'] },
      {
        label: '实施修复',
        skills: ['superpowers:executing-plans', 'executing-plans'],
        optional: true,
      },
      { label: '验证修复', skills: ['superpowers:verification-before-completion', 'verification-before-completion'] },
      { label: '提交', skills: ['commit'] },
    ],
  },
  {
    id: 'code-review',
    name: '代码审查',
    description: '收到代码审查反馈后的处理流程',
    triggers: [
      'review feedback', 'pr comments', 'code review',
      '审查反馈', 'PR反馈', '代码审查',
    ],
    steps: [
      { label: '接收审查', skills: ['superpowers:receiving-code-review', 'receiving-code-review'] },
      { label: '实施修改', skills: ['superpowers:executing-plans', 'executing-plans'] },
      { label: '验证', skills: ['superpowers:verification-before-completion', 'verification-before-completion'] },
    ],
  },
]

/**
 * 根据skill名称查找该skill所在的预定义工作流
 */
export function findWorkflowBySkill(skillName: string): SkillWorkflow | null {
  return BUILTIN_WORKFLOWS.find(wf =>
    wf.steps.some(step => step.skills.includes(skillName)),
  ) ?? null
}

/**
 * 在工作流中查找skill所在的步骤索引
 */
export function findStepIndex(workflow: SkillWorkflow, skillName: string): number {
  return workflow.steps.findIndex(step => step.skills.includes(skillName))
}
