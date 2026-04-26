import { AGENT_TOOL_NAME } from '../../tools/AgentTool/constants.js'
import { registerBundledSkill } from '../bundledSkills.js'

const STREAM_PROTOCOL_PROMPT = `# /stream-protocol — 流式协议对齐与调试

系统化验证和修复 WebSocket/SSE 流式事件协议，确保后端产生的事件与前端消费者完全对齐。

## 适用场景

- 替换后端引擎后，流式事件格式不匹配
- 前端收不到消息/工具结果/状态更新
- WebSocket 连接正常但 UI 无响应
- SSE 事件被静默丢弃
- 新增事件类型需要全链路验证
- 任何"后端有输出但前端不显示"的问题

## Phase 1: 全链路事件追踪

使用 ${AGENT_TOOL_NAME} 并行启动 2 个 Explore agent:

### Agent 1: 前端事件消费链

从 WebSocket/SSE 连接入口开始，追踪事件处理链:

\`\`\`
入口点搜索:
- WebSocket: onmessage, addEventListener('message'), useWebSocket, socket.on
- SSE: EventSource, onmessage, addEventListener
- Fetch streaming: getReader, ReadableStream
\`\`\`

对每个 event_type 记录:
1. **dispatch 条件** — switch/if 分支的精确匹配值
2. **消费字段** — 读取了 event.data 的哪些字段
3. **必需字段** — 缺失时会报错或静默失败
4. **可选字段** — 有默认值或 fallback
5. **下游效果** — 更新了什么 state/UI

产出: **前端事件协议规范表**

| event_type | 必需字段 | 可选字段 | 下游效果 | 静默丢弃? |
|-----------|---------|---------|---------|----------|
| message_chunk | id, role, content | agent, finish_reason, reasoning_content | 追加文本到聊天 | 是 |
| observation_log | content | agent, id | 显示工具观察日志 | 是 |
| ... | ... | ... | ... | ... |

### Agent 2: 后端事件生产链

从引擎/适配层的 yield/emit 开始，追踪事件生产链:

\`\`\`
生产点搜索:
- Python: yield {event_type:...}, async for ... yield
- TypeScript: yield*, next(), emit()
\`\`\`

对每个事件记录:
1. **生产位置** — 文件:行号
2. **event_type 值** — 精确字符串
3. **包含字段** — 完整字段集
4. **条件** — 什么条件下生产这个事件
5. **中间层修改** — WebSocket 包装/中间件是否修改字段

产出: **后端事件生产清单**

## Phase 2: 协议比对

将前端规范和后端清单逐行比对:

### 2.1 event_type 对齐矩阵

\`\`\`
前端期望         后端生产         匹配状态
─────────────────────────────────────
message_chunk    message_chunk    ✅ 匹配
observation_log  observation_log  ✅ 匹配
xxx_card         (缺失)           ❌ 缺失
(未知)           agent_response   ⚠️  无人消费
\`\`\`

### 2.2 字段级对齐

对每个匹配的 event_type，检查字段:

\`\`\`
event_type: message_chunk
字段        前端期望  后端提供  状态
──────────────────────────────────
id          必需      ✅       ✅
role        必需      ✅       ✅
content     必需      ✅       ✅
agent       可选      ❌       ⚠️ 缺失(可选)
finish_reason 可选    ✅       ✅
reasoning_content 可选 ❌      ⚠️ 缺失(深度思考不显示)
\`\`\`

### 2.3 WebSocket 包装层检查

很多项目有 WebSocket 中间层，会修改事件:

\`\`\`python
# 典型包装层
def _process_websocket_event(raw_event):
    return {
        "type": raw_event.get("event_type"),  # 字段重命名!
        "request_id": self.request_id,        # 注入新字段!
        "timestamp": now(),                    # 注入新字段!
        "data": raw_event,                     # 嵌套原始事件!
    }
\`\`\`

**检查**:
- 前端从 \`event.data.xxx\` 还是 \`event.xxx\` 读取？
- 包装层是否改了 event_type 的 key 名？(event_type → type)
- 是否有字段被包装层吞掉？

## Phase 3: 实时验证

### 3.1 WebSocket 抓包验证

\`\`\`bash
# 使用 websocat 连接并查看原始消息
websocat ws://localhost:8000/api/v1/ws-chat/run/stream

# 或在浏览器 DevTools → Network → WS → Messages 中查看
\`\`\`

### 3.2 SSE 验证

\`\`\`bash
# 使用 curl 查看 SSE 流
curl -N -H "Accept: text/event-stream" http://localhost:8000/api/v1/chat/stream
\`\`\`

### 3.3 对比测试

同时用旧引擎和新引擎发送相同消息，逐事件对比:
- 事件数量是否一致
- 每个事件的 event_type 是否一致
- 字段集是否一致
- 最终 stop 事件是否都正确发出

## Phase 4: 修复模板

### 4.1 event_type 修复

\`\`\`python
# ❌ 错误
event = {"event_type": "agent_response", "content": text}

# ✅ 正确 (对齐前端 switch)
event = {"event_type": "message_chunk", "content": text}
\`\`\`

### 4.2 必需字段补全

\`\`\`python
# ❌ 缺少字段
event = {"event_type": "message_chunk", "content": text}

# ✅ 完整字段
event = {
    "event_type": "message_chunk",
    "id": message_id,
    "role": "assistant",
    "content": text,
    "thread_id": thread_id,
    "agent": agent_name,
}
\`\`\`

### 4.3 finish_reason 处理

\`\`\`python
# 流结束时必须发送 finish_reason="stop"
yield {
    "event_type": "message_chunk",
    "id": message_id,
    "role": "assistant",
    "content": "",  # 空内容
    "finish_reason": "stop",
    "thread_id": thread_id,
}
\`\`\`

## 检查清单

- [ ] 所有前端 event_type 分支都有对应的后端事件
- [ ] 所有必需字段都被提供
- [ ] event_type 字符串精确匹配（区分大小写）
- [ ] WebSocket 包装层的字段映射正确
- [ ] finish_reason="stop" 在流结束时正确发送
- [ ] 错误事件格式正确
- [ ] 特殊工具 (write_todos 等) 的事件格式正确
- [ ] 深度思考 (reasoning_content) 字段正确传递
- [ ] 工具观察日志 (observation_log) 包含有意义的描述
- [ ] 对比测试通过 (新旧引擎事件格式一致)

## 常见陷阱

1. **前端 switch 没有 default** — 未识别的 event_type 被静默丢弃，不会报错
2. **字段名 typo** — \`event_type\` vs \`eventType\` vs \`type\`, 一字之差全链路断裂
3. **嵌套层级** — 有些包装层把事件放到 \`data\` 字段里，前端要多解一层
4. **finish_reason 遗漏** — 不发 stop 事件，前端永远显示 loading
5. **空 content 过滤** — 有些前端过滤 \`!content\` 的事件，但 finish_reason 事件 content 就是空的
6. **id 不唯一** — 同一个 message 的多个 chunk 应该用同一个 id
7. **异步时序** — 工具结果事件可能在工具开始事件之前到达
`

export function registerStreamProtocolSkill(): void {
  registerBundledSkill({
    name: 'stream-protocol',
    description:
      'Verify and fix WebSocket/SSE streaming event protocols between backend engine and frontend consumer.',
    aliases: ['protocol-check', 'ws-debug'],
    userInvocable: true,
    async getPromptForCommand(args) {
      let prompt = STREAM_PROTOCOL_PROMPT
      if (args) {
        prompt += `\n## Debug Target\n\n${args}`
      }
      return [{ type: 'text', text: prompt }]
    },
  })
}
