import { AGENT_TOOL_NAME } from '../../tools/AgentTool/constants.js'
import { registerBundledSkill } from '../bundledSkills.js'

const ADAPTER_AUDIT_PROMPT = `# /adapter-audit — 适配层协议对齐审计

系统化审查适配层(Adapter)是否正确对齐新旧系统的事件协议。适配层是引擎替换中**最易出错**的组件——一个字段名错误或缺失就会导致前端静默失败。

## 背景

当你替换系统的底层引擎时，适配层负责将新引擎的输出转换为旧系统前端期望的格式。这个 skill 帮你系统化检查所有映射是否完整、正确。

## Phase 1: 收集协议规范

使用 ${AGENT_TOOL_NAME} 并行启动 3 个 Explore agent:

### Agent 1: 前端事件消费者分析
搜索前端代码中所有事件处理分支:
- WebSocket onMessage / handleMessage 中的 event_type 分发
- SSE EventSource 的 event handler
- 每种 event_type 读取了哪些字段 (id, role, content, agent, finish_reason, data_type, name, tool_calls, reasoning_content 等)
- 哪些字段缺失会导致静默失败 vs 显式报错

### Agent 2: 原有后端事件生产者分析
搜索原有引擎的流式输出代码:
- 所有 yield / emit / send 的事件结构
- 每种事件类型的完整字段集
- 中间件/回调注入的额外字段
- 特殊工具的自定义事件 (registered tool events)
- 消息持久化的调用签名

### Agent 3: 适配层当前实现分析
读取适配层代码:
- 当前映射了哪些事件类型
- 每个事件输出了哪些字段
- 哪些错误处理路径存在
- 资源管理 (注册/注销、flush)

## Phase 2: 逐项比对

将三个 agent 的结果汇总，按以下维度逐项对比:

### 2.1 事件类型对齐

| 序号 | 前端期望的 event_type | 原后端生产 | 适配层是否覆盖 | 状态 |
|------|----------------------|-----------|---------------|------|
| 1    | message_chunk        | ✅        | ?             | ?    |
| 2    | observation_log      | ✅        | ?             | ?    |
| ...  | ...                  | ...       | ...           | ...  |

**关键检查**: 适配层使用的 event_type 字符串是否与前端 switch/if 分支**精确匹配**？常见错误:
- \`"agent_response"\` vs \`"message_chunk"\` — 一字之差，前端完全不识别
- \`"tool_result"\` vs 动态注册的 event_type — 前端可能只处理注册事件

### 2.2 字段完整性

对每种事件类型，检查:

| 字段 | 前端是否读取 | 原后端是否提供 | 适配层是否提供 | 严重程度 |
|------|------------|--------------|--------------|---------|
| id   | ✅         | ✅           | ?            | CRITICAL |
| role | ✅         | ✅           | ?            | HIGH     |
| agent| ✅         | ✅           | ?            | MEDIUM   |
| ...  | ...        | ...          | ...          | ...      |

### 2.3 特殊处理对齐

检查以下特殊场景是否在适配层中覆盖:
- [ ] **TodoStep 跟踪** (write_todos 工具、todo_list_card、todo_step_output 事件)
- [ ] **注册工具事件** (_build_registered_tool_event 动态类型)
- [ ] **工具描述生成** (MCP 本地化名称、LLM 生成描述)
- [ ] **工具结果摘要** (LLM 生成摘要而非截断)
- [ ] **深度思考** (reasoning_content 字段)
- [ ] **用户中断** (StopCheckCallback / Redis stop key)
- [ ] **消息持久化** (cc_messages 表, 调用签名完全匹配)

### 2.4 错误处理与资源管理

- [ ] GeneratorExit → 刷盘 AI 消息 + 发送 error_run_log
- [ ] CancelledError → 刷盘 AI 消息 + 发送 error_run_log + re-raise
- [ ] 通用 Exception → 发送 error_run_log + re-raise
- [ ] finally → TodoList flush_to_db + _conversation_tracker.unregister_execution

### 2.5 WebSocket 包装层兼容

如果有 WebSocket 中间层 (如 \`_process_websocket_event\`):
- 检查包装层是否对事件做了字段补充 (request_id, timestamp, type 重映射)
- 确保适配层输出经过包装后仍符合前端期望

## Phase 3: 生成修复清单

按严重程度排序:

### CRITICAL (导致功能不可用)
- event_type 错误
- 必需字段缺失 (id, content)
- 消息持久化签名错误

### HIGH (导致功能降级)
- 注册工具事件缺失 (卡片不显示)
- TodoStep 跟踪缺失
- 错误处理缺失 (无法优雅终止)

### MEDIUM (影响体验)
- 工具描述非本地化
- 结果摘要为截断而非 LLM 生成
- agent 字段缺失
- 追踪/监控缺失

### LOW (可后续优化)
- Langfuse 追踪
- 性能日志

## Phase 4: 执行修复

逐项修复，每修复一项后:
1. 验证语法正确
2. 确认不影响已有逻辑
3. 标记该项为已完成

## 经验教训 (来自实际迁移)

1. **适配层必须严格对齐原有事件协议** — "差不多" 是不够的
2. **前端 switch 通常没有 default 分支** — 未识别的 event_type 被静默丢弃
3. **字段缺失比字段多余严重得多** — 多余字段被忽略，缺失字段导致 undefined
4. **消息持久化函数签名通常复杂** — 别猜，读源码确认每个参数
5. **特殊工具 (write_todos 等) 有独立事件流** — 不能用通用处理
6. **错误处理和资源清理容易遗漏** — 使用 finally 保证执行
`

export function registerAdapterAuditSkill(): void {
  registerBundledSkill({
    name: 'adapter-audit',
    description:
      'Systematically audit an adapter layer for event protocol alignment between new engine and existing frontend/backend.',
    aliases: ['audit-adapter'],
    userInvocable: true,
    async getPromptForCommand(args) {
      let prompt = ADAPTER_AUDIT_PROMPT
      if (args) {
        prompt += `\n## Audit Target\n\n${args}`
      }
      return [{ type: 'text', text: prompt }]
    },
  })
}
