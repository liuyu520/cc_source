import { AGENT_TOOL_NAME } from '../../tools/AgentTool/constants.js'
import { registerBundledSkill } from '../bundledSkills.js'

const ENGINE_MIGRATE_PROMPT = `# /engine-migrate — Agent 引擎跨框架迁移

将一个项目的 AI Agent 引擎（循环、工具系统、流式输出）迁移到另一个项目中，替换其原有引擎，同时保持业务逻辑、API 端点、数据库模型不变。

## 适用场景

- TypeScript Agent → Python Agent (或反向)
- LangChain/LangGraph Agent → 原生 Anthropic SDK Agent
- 自定义 Agent → 标准化 Agent 框架
- 单体 Agent → 微服务 Agent
- 任何"保留业务壳、替换 AI 核心"的场景

## Phase 1: 源引擎能力分析

使用 ${AGENT_TOOL_NAME} 启动一个 Explore agent 分析**源项目**的 Agent 核心:

1. **核心循环**: 找到 while-true 循环（agentic loop），记录:
   - 入口函数/方法签名
   - 消息格式 (user/assistant/tool_use/tool_result)
   - 循环终止条件 (stop_reason, max_turns, no tool_use)
   - 流式输出方式 (AsyncGenerator/AsyncIterator/callback)

2. **工具系统**: 列出所有工具定义接口:
   - 工具注册方式 (装饰器/@tool/手动注册)
   - 输入 schema 定义 (Zod/Pydantic/JSON Schema)
   - 工具执行方式 (同步/异步/并发策略)
   - 工具结果格式

3. **高级特性**:
   - Token 预算管理 (递减收益检测)
   - 自动上下文压缩 (autoCompact)
   - 工具编排 (并行/串行批次)
   - 错误恢复 (max_output_tokens 扩升、重试)
   - Agent 嵌套/子Agent

## Phase 2: 目标项目架构审查

使用 ${AGENT_TOOL_NAME} 启动一个 Explore agent 分析**目标项目**:

1. **当前引擎**: 当前用什么 Agent 框架？入口在哪？
2. **接入点**: Agent 在哪里被调用？(HTTP handler / WebSocket / CLI)
3. **工具生态**: 现有多少工具？用什么格式定义？
4. **事件协议**: 前端/客户端期望什么事件格式？
5. **持久化**: 消息/工具结果怎么存储？
6. **基础设施**: 有哪些中间件/回调/钩子？

## Phase 3: 模块规划

基于分析结果，规划新引擎的模块结构:

\`\`\`
target_project/agents/new_engine/
├── agent.py|ts          # 会话级 Agent (移植核心循环)
├── query_loop.py|ts     # agentic 循环 (while-true + API 调用)
├── tool_base.py|ts      # 工具定义基类
├── tool_registry.py|ts  # 工具注册与过滤
├── tool_bridge.py|ts    # 旧框架工具 → 新格式 的包装层
├── streaming_exec.py|ts # 流式工具执行器 (并发/串行)
├── token_budget.py|ts   # Token 预算管理
├── auto_compact.py|ts   # 自动上下文压缩
├── message_types.py|ts  # 消息类型定义
├── system_prompt.py|ts  # 系统提示词组装
├── adapter.py|ts        # 新引擎 → 目标项目事件格式 适配层
├── errors.py|ts         # 错误分类与恢复
└── __init__.py|ts       # 公共 API
\`\`\`

## Phase 4: 特性开关 + 最小侵入接入

**关键原则**: 通过特性开关 (feature flag) 控制新旧引擎切换，确保随时可回滚。

接入点修改清单 (通常只需改 2-3 个文件):
1. **Agent 构建入口** — 加 if/else: 新引擎 or 旧引擎
2. **流式处理** — 加类型检测: isinstance(agent, NewAgent) → 用适配器
3. **配置文件** — 加新引擎相关配置项

**禁止修改的文件**:
- 所有 API 端点/路由
- 所有数据库模型
- 所有现有工具实现
- WebSocket/SSE 连接管理器
- 消息队列/缓存基础设施

## Phase 5: 适配层实现

适配层是**最易出错**的部分。必须对齐:
1. 事件类型名 (event_type 的精确字符串值)
2. 每个事件的字段集 (id, role, agent, content, finish_reason, thread_id, ...)
3. 特殊工具处理 (write_todos, ask_clarification 等)
4. 消息持久化调用签名
5. 错误处理 (GeneratorExit, CancelledError, 自定义异常)
6. 资源清理 (tracker flush, execution unregister)

> **经验教训**: 适配层不要"差不多就行"。前端收到一个字段名不对或缺失的事件就会静默失败。用 /adapter-audit 做系统化检查。

## Phase 6: 验证

1. **语法验证**: 所有新文件通过 AST 解析
2. **单元验证**: 新引擎独立运行，能完成简单对话
3. **集成验证**: 通过原有前端/客户端发起对话，验证事件格式完全一致
4. **回滚验证**: 关闭特性开关，验证完全回退到旧引擎
5. **工具验证**: 至少测试 3 个旧工具通过桥接层正常执行

## 检查清单

- [ ] 源引擎核心循环已完整分析
- [ ] 目标项目接入点已确认
- [ ] 模块结构已规划并创建
- [ ] 核心循环已移植 (query_loop)
- [ ] 工具基类已定义 (tool_base)
- [ ] 工具桥接已实现 (tool_bridge)
- [ ] 适配层已实现并通过审计 (adapter)
- [ ] 特性开关已添加
- [ ] 接入点已修改 (2-3 个文件)
- [ ] 消息持久化调用签名正确
- [ ] 错误处理完整 (3 种异常 + finally)
- [ ] 集成测试通过
- [ ] 回滚测试通过
`

export function registerEngineMigrateSkill(): void {
  registerBundledSkill({
    name: 'engine-migrate',
    description:
      'Systematically migrate an AI Agent engine across frameworks/languages while preserving business logic and API compatibility.',
    aliases: ['migrate-engine'],
    userInvocable: true,
    async getPromptForCommand(args) {
      let prompt = ENGINE_MIGRATE_PROMPT
      if (args) {
        prompt += `\n## User Context\n\n${args}`
      }
      return [{ type: 'text', text: prompt }]
    },
  })
}
