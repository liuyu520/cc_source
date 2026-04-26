// src/services/skillSearch/workflowTracker.ts
// 会话级工作流状态跟踪器，追踪skill执行序列并建议下一步

import type { Command } from '../../types/command.js'
import {
  findStepIndex,
  findWorkflowBySkill,
  type SkillWorkflow,
} from './skillWorkflows.js'

export type WorkflowHint = {
  source: 'frontmatter' | 'workflow'
  nextSkills: string[]
  stepLabel?: string
  optional?: boolean
  condition?: string
  remaining?: string[]
  workflowComplete?: boolean
  workflowName?: string
  currentStep?: number
  totalSteps?: number
}

/**
 * 会话级工作流跟踪器
 * 生命周期与会话一致，不跨会话持久化
 */
class WorkflowTracker {
  private activeWorkflow: SkillWorkflow | null = null
  private currentStepIndex = 0
  private completedSkills = new Set<string>()

  /**
   * 当一个skill执行完成时调用，推进工作流状态
   * 返回下一步建议，或null表示无建议
   *
   * 优先级：frontmatter声明的next > 预定义工作流步骤
   */
  onSkillCompleted(skillName: string, command?: Command): WorkflowHint | null {
    this.completedSkills.add(skillName)

    // 优先级1: 检查frontmatter声明的next
    if (command?.next && command.next.length > 0) {
      return {
        source: 'frontmatter',
        nextSkills: command.next,
      }
    }

    // 优先级2: 检查预定义工作流
    if (!this.activeWorkflow) {
      this.activeWorkflow = findWorkflowBySkill(skillName)
      if (this.activeWorkflow) {
        this.currentStepIndex = findStepIndex(this.activeWorkflow, skillName)
      }
    }

    if (this.activeWorkflow) {
      return this.advanceWorkflow()
    }

    return null
  }

  /**
   * 推进工作流到下一步
   */
  private advanceWorkflow(): WorkflowHint | null {
    const wf = this.activeWorkflow!
    this.currentStepIndex++

    if (this.currentStepIndex >= wf.steps.length) {
      // 工作流完成
      const result: WorkflowHint = {
        source: 'workflow',
        nextSkills: [],
        workflowComplete: true,
        workflowName: wf.name,
        currentStep: wf.steps.length,
        totalSteps: wf.steps.length,
      }
      this.activeWorkflow = null
      this.currentStepIndex = 0
      return result
    }

    const nextStep = wf.steps[this.currentStepIndex]!
    const remaining = wf.steps
      .slice(this.currentStepIndex + 1)
      .map(s => s.label)

    return {
      source: 'workflow',
      nextSkills: nextStep.skills,
      stepLabel: nextStep.label,
      optional: nextStep.optional,
      condition: nextStep.condition,
      remaining,
      workflowName: wf.name,
      currentStep: this.currentStepIndex + 1,
      totalSteps: wf.steps.length,
    }
  }

  /**
   * 重置跟踪器状态
   */
  reset(): void {
    this.activeWorkflow = null
    this.currentStepIndex = 0
    this.completedSkills.clear()
  }

  /**
   * 获取当前活跃工作流信息
   */
  getActiveWorkflow(): { name: string; step: number; total: number } | null {
    if (!this.activeWorkflow) return null
    return {
      name: this.activeWorkflow.name,
      step: this.currentStepIndex + 1,
      total: this.activeWorkflow.steps.length,
    }
  }
}

// 会话级单例
let _instance: WorkflowTracker | null = null

export function getWorkflowTracker(): WorkflowTracker {
  if (!_instance) {
    _instance = new WorkflowTracker()
  }
  return _instance
}

export function resetWorkflowTracker(): void {
  _instance = null
}
