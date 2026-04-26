import { AGENT_TOOL_NAME } from '../../tools/AgentTool/constants.js'
import { registerBundledSkill } from '../bundledSkills.js'

const MULTI_ENTRY_AUDIT_PROMPT = `# /multi-entry-audit — 多入口一致性审计

当替换系统底层引擎时，系统化发现并修复所有调用入口，确保每个入口都正确接入新引擎。

## 背景

企业级项目通常有多个入口调用同一个底层服务（Agent、LLM、数据管道等）。替换底层时，容易遗漏某些入口，导致部分接口走旧路径或直接报错。

典型场景:
- HTTP SSE 接口和 WebSocket 接口共享同一个 Agent 构建函数，但各自有独立的流式消费逻辑
- REST API 和 gRPC 接口调用同一个 service 层
- 定时任务和用户触发走不同路径但依赖同一个引擎
- CLI 和 Web 前端调用同一个后端

## Phase 1: 发现所有入口

使用 ${AGENT_TOOL_NAME} 启动 Explore agent，搜索所有调用底层引擎构建函数的入口:

\`\`\`
搜索策略:
1. 找到引擎构建函数 (如 build_agent, create_engine, get_graph)
2. grep 所有 import 和调用这个函数的文件
3. 追踪每个调用者的上层路由/handler
4. 列出完整的入口清单
\`\`\`

产出表格:

| 入口 | 接口路径 | 文件:行号 | 消费方式 | 需要适配? |
|------|---------|----------|---------|----------|
| WebSocket | /ws-chat/run/stream | websocket_chat.py:2251 | chat_stream() | 已覆盖 |
| HTTP SSE | /llm-chat/stream | llm_chat_stream.py:973 | graph.astream() | ❌ 未覆盖! |
| 定时任务 | scheduler.py:45 | run_agent() | 需检查 |
| ... | ... | ... | ... | ... |

## Phase 2: 分析每个入口的消费方式

对每个入口，分析它如何消费引擎返回值:

### 2.1 方法调用兼容性

旧引擎返回的对象有哪些方法被调用？新引擎是否有对应方法？

\`\`\`
旧引擎 (LangGraph):
- graph.astream(input, config, stream_mode=["messages","updates"], subgraphs=True)
- graph.invoke(input, config)
- graph.get_state(config)

新引擎 (ClaudeAgent):
- agent.submit_message(user_input, history_messages=history)
- agent.load_history(messages)
- ❌ 没有 astream(), invoke(), get_state() 方法!
\`\`\`

### 2.2 事件格式兼容性

每个入口期望什么事件格式？

\`\`\`
WebSocket 入口:
- chat_stream() 返回 dict 事件 → _process_websocket_event() 包装

SSE 入口:
- graph.astream() 返回 (agent, mode, data) 三元组
- _emit_stream_event("message_chunk", data) 转 SSE

不同入口对事件格式的期望可能不同!
\`\`\`

## Phase 3: 制定适配方案

对每个未覆盖的入口，选择适配策略:

### 策略 A: Adapter 层适配 (推荐)
在入口处检测新引擎类型，走 Adapter 转换:
\`\`\`python
if isinstance(graph, NewAgent):
    # 走适配路径
    adapter = Adapter(...)
    async for event in adapter.adapt_stream(graph, ...):
        yield format_for_this_entry(event)
    return
# 否则走原路径
\`\`\`

### 策略 B: 新引擎实现兼容方法
给新引擎类添加兼容方法 (不推荐 — 侵入性大):
\`\`\`python
class NewAgent:
    async def astream(self, *args, **kwargs):
        # 模拟旧接口...
\`\`\`

### 策略 C: 统一入口层
将所有入口收拢到同一个 runner 函数 (长期方案):
\`\`\`python
# 所有入口都通过 unified_stream() 消费
async for event in unified_stream(graph, ...):
    yield format_for_entry(event)
\`\`\`

## Phase 4: 逐一修复

对每个未覆盖的入口:
1. 添加新引擎类型检测
2. 通过 Adapter 转换事件
3. 保持该入口原有的事件格式和持久化逻辑
4. 验证语法正确
5. 标记为已修复

## Phase 5: 回归验证

- [ ] 每个入口在新引擎模式下正常工作
- [ ] 每个入口在旧引擎模式下 (关闭特性开关) 正常工作
- [ ] 事件格式与前端/消费者完全一致
- [ ] 消息持久化正确
- [ ] 错误处理完整

## 经验教训

1. **不要假设只有一个入口** — 企业项目通常有 WebSocket + HTTP + 定时任务 + CLI 等多个入口
2. **搜索所有 import 比搜索路由更可靠** — 路由可能动态注册，但 import 必须静态存在
3. **每个入口的消费方式可能不同** — WebSocket 用 chat_stream()，SSE 直接 graph.astream()，不能一刀切
4. **先检测类型再调用** — 不要在旧代码的 except 中静默降级，这会掩盖问题
5. **adapter 复用但格式适配需定制** — 同一个 Adapter 可以在不同入口复用，但输出格式转换是入口特定的
`

export function registerMultiEntryAuditSkill(): void {
  registerBundledSkill({
    name: 'multi-entry-audit',
    description:
      'Discover and fix all entry points that call a replaced engine/service, ensuring every entry path is correctly adapted.',
    aliases: ['entry-audit', 'audit-entries'],
    userInvocable: true,
    async getPromptForCommand(args) {
      let prompt = MULTI_ENTRY_AUDIT_PROMPT
      if (args) {
        prompt += `\n## Audit Target\n\n${args}`
      }
      return [{ type: 'text', text: prompt }]
    },
  })
}
