import { registerBundledSkill } from '../bundledSkills.js'
import {
  DELEGATE_TO_EXTERNAL_AGENT_TOOL_NAME,
  CHECK_DELEGATE_STATUS_TOOL_NAME,
  GET_DELEGATE_RESULT_TOOL_NAME,
} from '../../tools/ExternalAgentDelegate/constants.js'

// /codex skill — 将任务委派给 OpenAI Codex CLI 执行
const CODEX_PROMPT = `# /codex — 委派任务给 OpenAI Codex

将当前任务委派给本机安装的 OpenAI Codex CLI（\`codex --quiet --yolo\`）执行。
Codex 拥有完整的文件系统访问权限，可自主编写、修改和运行代码。

## 使用方式

用户的参数即为要委派给 Codex 的任务描述。如果没有参数，则基于当前对话上下文推断任务。

## 执行流程

1. **确定任务描述**
   - 如果用户提供了参数，直接使用该参数作为 task
   - 如果没有参数，根据对话上下文（最近讨论的问题、待修复的 bug、待实现的功能）生成清晰的任务描述
   - 任务描述应足够详细，让 Codex 能独立完成，包含：目标、相关文件路径、预期输出

2. **委派给 Codex**
   使用 ${DELEGATE_TO_EXTERNAL_AGENT_TOOL_NAME} 工具发起委派：
   - \`agent_type\`: "codex"
   - \`task\`: 任务描述（详细、清晰）
   - \`cwd\`: 当前工作目录（默认即可）
   - \`run_in_background\`: true（默认后台运行，任务完成后收到通知）

3. **监控进度（可选）**
   - 后台模式下，任务完成会通过 <task-notification> 自动通知
   - 如需主动检查，使用 ${CHECK_DELEGATE_STATUS_TOOL_NAME} 工具传入 delegate_id

4. **获取结果**
   任务完成后使用 ${GET_DELEGATE_RESULT_TOOL_NAME} 工具获取完整输出，然后向用户汇报结果摘要。

## 注意事项

- Codex 运行时会以 \`--yolo\` 模式自动批准所有操作，无需人工确认
- 适合委派给 Codex 的任务：代码生成、重构、调试、测试编写、文件批量修改
- 不适合：需要用户交互的操作、涉及网络请求的任务（Codex 无网络访问）
- 如果 Codex 未安装，会提示 \`npm install -g @openai/codex\`
`

export function registerCodexSkill(): void {
  registerBundledSkill({
    name: 'codex',
    description:
      'Delegate a task to the local OpenAI Codex CLI (codex --quiet --yolo). Codex runs autonomously with full filesystem access.',
    aliases: ['delegate-codex'],
    argumentHint: '<task description>',
    userInvocable: true,
    async getPromptForCommand(args) {
      let prompt = CODEX_PROMPT
      if (args) {
        prompt += `\n## 用户指定任务\n\n${args}\n`
      }
      return [{ type: 'text', text: prompt }]
    },
  })
}
