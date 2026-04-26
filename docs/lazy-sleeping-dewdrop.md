# Super V5 Agent 引擎替换 — 总体迁移方案

## Context

**目标**: 以 Super V5 (Python/FastAPI) 为基座项目，将本项目 (claude-code-minimaxOk) 的 AI Agent 核心能力（QueryEngine、工具系统、流式执行）移植为 Python 模块，替换 Super V5 中的 LangGraph/LangChain/deepagents Agent 引擎，同时保持全部 200+ HTTP API 端点、数据库模型、外部服务集成不变。

**为什么**: 本项目的 Agent 引擎更强大（完全依赖 LLM 智能选择工具，无需手动意图分类；支持 Agent 嵌套、流式工具执行、自动上下文压缩、token 预算管理），但 Super V5 拥有完整的业务生态（计划系统、IM、项目管理等 200+ API）。结合两者优势。

**优先级**: 1) AI 聊天 + 意图识别  2) IM + 通知 + 对话

---

## Phase 0: 项目准备 & 基础设施

### 0.1 在 Super V5 中创建 Agent 引擎模块
```
superv5/app/agents/claude_engine/
├── __init__.py              # 公共 API: ClaudeAgent, Tool, QueryEngine
├── agent.py                 # ClaudeAgent 类 (移植自 QueryEngine.ts)
├── query_loop.py            # 核心 agentic 循环 (移植自 query.ts)
├── tool_base.py             # Tool 基类、注册表、Schema (移植自 Tool.ts)
├── tool_registry.py         # 工具注册与过滤 (移植自 tools.ts)
├── streaming_executor.py    # 流式工具执行器 (移植自 StreamingToolExecutor.ts)
├── tool_orchestration.py    # 工具批次分组 (移植自 toolOrchestration.ts)
├── token_budget.py          # Token 预算管理 (移植自 tokenBudget.ts)
├── auto_compact.py          # 自动上下文压缩 (移植自 autoCompact.ts)
├── message_types.py         # 消息类型定义 (移植自 types/message.ts)
├── system_prompt.py         # 系统提示词组装 (移植自 prompts.ts)
├── permissions.py           # 权限系统 (简化版)
├── errors.py                # 错误分类与恢复
└── adapter.py               # Super V5 适配层 (转换流式事件为 WebSocket/SSE 格式)
```

### 0.2 依赖安装
```toml
# 在 pyproject.toml 中添加
anthropic = ">=0.76.0"     # Anthropic Python SDK (已有)
pydantic = ">=2.12.0"      # 替代 Zod (已有)
```
无需额外新依赖 — Super V5 已有 `anthropic`、`pydantic`、`asyncio` 等全部所需库。

### 0.3 环境变量
```bash
# 新增配置 (app/core/config.py)
CLAUDE_ENGINE_ENABLED=true          # 特性开关，支持回滚
ANTHROPIC_BASE_URL=...              # 已有
ANTHROPIC_API_KEY=...               # 已有
ANTHROPIC_MODEL=claude-sonnet-4-20250514  # 模型选择
CLAUDE_MAX_TURNS=50                 # 最大循环轮数
CLAUDE_CONTEXT_WINDOW=200000        # 上下文窗口大小
CLAUDE_AUTO_COMPACT_THRESHOLD=0.85  # 自动压缩阈值 (占窗口百分比)
```

---

## Phase 1: 核心引擎移植 (Python 化 QueryEngine)

### 1.1 消息类型 → `message_types.py`

**源文件**: `src/types/message.ts` (line 124)
**目标**: 定义 Python 消息类型，兼容 Anthropic API 格式

```python
# 关键类型 (Pydantic BaseModel)
class ToolUseBlock(BaseModel):
    type: Literal["tool_use"] = "tool_use"
    id: str
    name: str
    input: dict[str, Any]

class ToolResultBlock(BaseModel):
    type: Literal["tool_result"] = "tool_result"
    tool_use_id: str
    content: str | list[dict]
    is_error: bool = False

class UserMessage(BaseModel):
    role: Literal["user"] = "user"
    content: str | list[dict]

class AssistantMessage(BaseModel):
    role: Literal["assistant"] = "assistant"
    content: list[dict]  # text + tool_use blocks
    stop_reason: str | None = None
```

### 1.2 Tool 基类 → `tool_base.py`

**源文件**: `src/Tool.ts` (line 362, `Tool` type; line 783, `buildTool()`)
**目标**: Python 工具定义接口

```python
class ToolDef(BaseModel):
    """工具定义基类"""
    name: str
    description: str
    input_schema: type[BaseModel]  # Pydantic model 替代 Zod
    is_concurrent_safe: bool = False
    is_read_only: bool = False
    max_result_size_chars: int = 120_000

    async def call(self, args: dict, context: "ToolUseContext") -> "ToolResult":
        raise NotImplementedError

    async def validate_input(self, args: dict, context: "ToolUseContext") -> dict | None:
        return None  # 返回 None 表示通过

    def to_api_schema(self) -> dict:
        """转换为 Anthropic API 的 tool 定义格式"""
        return {
            "name": self.name,
            "description": self.description,
            "input_schema": self.input_schema.model_json_schema()
        }
```

### 1.3 核心查询循环 → `query_loop.py`

**源文件**: `src/query.ts` (line 307, while-true loop)
**目标**: Python 异步生成器实现

```python
async def query_loop(
    client: anthropic.AsyncAnthropic,
    messages: list[dict],
    system_prompt: str,
    tools: list[ToolDef],
    *,
    max_turns: int = 50,
    context_window: int = 200_000,
    on_stream_event: Callable | None = None,
) -> AsyncIterator[StreamEvent]:
    """
    核心 agentic 循环 (移植自 query.ts line 307)
    
    循环逻辑:
    1. 调用 Anthropic API (streaming)
    2. 收集 tool_use blocks
    3. 执行工具 (并行/串行)
    4. 将 tool_result 追加到 messages
    5. 如果有 tool_use → 继续循环; 否则 → 结束
    """
    turn_count = 0
    while turn_count < max_turns:
        turn_count += 1
        
        # 自动压缩检查 (移植自 autoCompact.ts)
        messages = await maybe_auto_compact(messages, context_window)
        
        # 调用 API (streaming)
        tool_use_blocks = []
        async with client.messages.stream(
            model=model,
            system=system_prompt,
            messages=messages,
            tools=[t.to_api_schema() for t in tools],
            max_tokens=16384,
        ) as stream:
            async for event in stream:
                yield StreamEvent(type="stream", data=event)
                # 收集 tool_use blocks
                if is_tool_use_event(event):
                    tool_use_blocks.append(extract_tool_use(event))
        
        assistant_message = stream.get_final_message()
        messages.append({"role": "assistant", "content": assistant_message.content})
        
        # 无工具调用 → 结束
        if not tool_use_blocks:
            yield StreamEvent(type="end", data=assistant_message)
            break
        
        # 执行工具 (移植自 StreamingToolExecutor)
        tool_results = await execute_tools(tool_use_blocks, tools, context)
        messages.append({"role": "user", "content": tool_results})
        
        yield StreamEvent(type="tool_results", data=tool_results)
```

### 1.4 流式工具执行器 → `streaming_executor.py`

**源文件**: `src/services/tools/StreamingToolExecutor.ts` (line 76-180)
**目标**: 并发工具执行 + 有序结果缓冲

```python
async def execute_tools(
    tool_use_blocks: list[ToolUseBlock],
    tools: list[ToolDef],
    context: ToolUseContext,
    max_concurrency: int = 10,
) -> list[ToolResultBlock]:
    """
    移植自 toolOrchestration.ts 的 partitionToolCalls() + runToolsConcurrently()
    
    规则:
    - concurrent_safe 的工具可以并行执行
    - 非 concurrent_safe 的工具串行执行
    - 结果按原始顺序返回
    """
    batches = partition_tool_calls(tool_use_blocks, tools)
    results = []
    for batch in batches:
        if batch.is_concurrent:
            batch_results = await asyncio.gather(
                *[run_single_tool(tc, tools, context) for tc in batch.calls],
                return_exceptions=True
            )
        else:
            batch_results = [await run_single_tool(batch.calls[0], tools, context)]
        results.extend(batch_results)
    return results
```

### 1.5 Token 预算管理 → `token_budget.py`

**源文件**: `src/query/tokenBudget.ts` (94 lines)
**目标**: 检测递减收益，防止无限循环

```python
class TokenBudgetTracker:
    """移植自 tokenBudget.ts 的 createBudgetTracker()"""
    continuation_count: int = 0
    last_delta_tokens: int = 0
    
    def should_continue(self, turn_tokens: int, budget: int) -> bool:
        """90% 阈值 + 递减收益检测 (连续3次 < 500 tokens)"""
```

### 1.6 自动压缩 → `auto_compact.py`

**源文件**: `src/services/compact/autoCompact.ts`
**目标**: 上下文接近限制时自动压缩历史消息

```python
async def maybe_auto_compact(
    messages: list[dict],
    context_window: int,
    threshold_ratio: float = 0.85,
) -> list[dict]:
    """
    移植自 autoCompact.ts
    当 token 估算 >= context_window * threshold 时，
    用 LLM 压缩早期消息为摘要
    """
```

### 1.7 ClaudeAgent 顶层封装 → `agent.py`

**源文件**: `src/QueryEngine.ts` (line 184-1186)
**目标**: 会话级 Agent，管理消息历史、工具注册、流式输出

```python
class ClaudeAgent:
    """
    会话级 Agent (移植自 QueryEngine)
    
    职责:
    - 管理消息历史
    - 组装系统提示词 (含工具描述)
    - 调用 query_loop() 执行 agentic 循环
    - 输出 StreamEvent 流
    """
    def __init__(self, tools: list[ToolDef], system_prompt: str, ...):
        self.messages = []
        self.tools = tools
        self.client = anthropic.AsyncAnthropic(...)
    
    async def submit_message(self, user_input: str) -> AsyncIterator[StreamEvent]:
        """提交用户消息，返回流式事件"""
        self.messages.append({"role": "user", "content": user_input})
        async for event in query_loop(
            self.client, self.messages, self.system_prompt, self.tools
        ):
            yield event
```

---

## Phase 2: 适配层 — 对接 Super V5 现有流程

### 2.1 适配器 → `adapter.py`

**目标**: 将 ClaudeAgent 的 StreamEvent 转换为 Super V5 的 WebSocket/SSE 事件格式

```python
class SuperV5Adapter:
    """
    将 ClaudeAgent 的事件流转换为 Super V5 前端期望的格式
    
    映射关系:
    - StreamEvent(type="stream", text chunk) → {"type": "agent_response", "content": "..."}
    - StreamEvent(type="tool_start") → {"type": "observation_log", "tool_name": "..."}
    - StreamEvent(type="tool_result") → {"type": "tool_call_result", ...}
    - StreamEvent(type="end") → {"type": "processing_end"}
    """
    
    async def stream_to_websocket(
        self,
        agent: ClaudeAgent,
        user_input: str,
        connection_manager,
        connection_id: str,
    ):
        """将 Agent 流式输出发送到 WebSocket 连接"""
        await connection_manager.send_message(
            connection_id, {"type": "processing_start"}
        )
        async for event in agent.submit_message(user_input):
            ws_event = self._convert_event(event)
            if ws_event:
                await connection_manager.send_message(connection_id, ws_event)
        await connection_manager.send_message(
            connection_id, {"type": "processing_end"}
        )
    
    async def stream_to_sse(
        self,
        agent: ClaudeAgent,
        user_input: str,
    ) -> AsyncIterator[str]:
        """将 Agent 流式输出转换为 SSE 格式"""
        async for event in agent.submit_message(user_input):
            sse_data = self._convert_to_sse(event)
            if sse_data:
                yield f"event: {sse_data['event']}\ndata: {json.dumps(sse_data['data'])}\n\n"
```

### 2.2 工具桥接 — 复用 Super V5 现有工具

**关键决策**: Super V5 的 25-30 个工具都是纯业务逻辑（HTTP 调用 + DB 操作），不依赖 LangGraph。只需要包装为新 `ToolDef` 格式。

**修改文件**: `app/agents/claude_engine/tool_bridge.py` (新建)

```python
def wrap_langchain_tool(lc_tool) -> ToolDef:
    """
    将 @langchain_core.tools.tool 装饰的函数包装为 ToolDef
    
    保留原有工具实现不变:
    - app/agents/im_agent/tools.py (13个IM工具)
    - app/agents/task_agent/tools.py (任务工具)
    - app/agents/carys_agent/tools.py (文档工具)
    - app/agents/sdlc/tools.py (SDLC工具)
    - app/agents/system_agent/tools.py (系统工具)
    - app/agents/tools/builtin/clarification_tool.py
    """
```

### 2.3 中间件适配

**Super V5 有 12 个中间件**，它们需要在新引擎中找到等价位置：

| 中间件 | 适配方式 |
|--------|---------|
| `DynamicSearchSkillsMiddleware` | → 在系统提示词中动态注入技能描述 |
| `InterruptToolMessageMiddleware` | → 在 query_loop 中加 interrupt 钩子 |
| `DanglingToolCallMiddleware` | → 在 query_loop 消息预处理中修复 |
| `UploadFileMiddleware` | → 在消息预处理中解析文件引用 |
| `ClarificationMiddleware` | → 保留 clarification tool，无需中间件 |
| `ToolErrorRetryMiddleware` | → 在 streaming_executor 中内置重试 |
| `MemoryMiddleware` | → 在系统提示词组装时注入记忆 |
| `UserContextMiddleware` | → 在系统提示词组装时注入用户上下文 |
| `TracingMessageMiddleware` | → 在 adapter 中发射跟踪事件 |
| `TodoMiddleware` | → 转为 Tool 实现 |
| `FilesystemMiddleware` | → 不需要（新引擎有原生文件工具） |
| `SubAgentMiddleware` | → 通过 Agent 嵌套实现（Phase 3） |

---

## Phase 3: 替换接入点 — 最小侵入式切换

### 3.1 修改 Agent 路由入口

**文件**: `app/agents/carys_agent/entry.py`
**修改**: `build_routed_carys_agent()` 函数

```python
async def build_routed_carys_agent(user_id, thread_id, *, last_user_text="", ...):
    # === 新增: 特性开关检查 ===
    if settings.CLAUDE_ENGINE_ENABLED:
        return await build_claude_agent(
            user_id=user_id,
            thread_id=thread_id,
            last_user_text=last_user_text,
            ...
        )
    
    # === 原有逻辑不变 (回滚路径) ===
    intent_result = await classify_intent(...)
    if intent_result.intent == "DIRECT_ANSWER":
        return build_direct_answer_agent(...)
    ...
```

### 3.2 修改流式处理

**文件**: `app/agents/executor/chat_stream_runner.py`
**修改**: `chat_stream()` 函数

```python
async def chat_stream(graph, *, initial_state, thread_id, ...):
    # === 新增: 检查是否为 ClaudeAgent ===
    if isinstance(graph, ClaudeAgent):
        adapter = SuperV5Adapter()
        async for event in adapter.convert_stream(graph, initial_state["messages"]):
            yield event
        return
    
    # === 原有 LangGraph 流式逻辑不变 ===
    ...
```

### 3.3 修改 WebSocket 处理器

**文件**: `app/api/v1/endpoints/websocket_chat.py`
**修改**: `_websocket_astream_workflow_generator()` (line 2157)

最小修改 — 只需确保 `build_routed_carys_agent()` 返回的 `ClaudeAgent` 对象能被 `chat_stream()` 正确处理。

---

## Phase 4: IM + 通知 + 对话 模块适配

### 4.1 IM 工具集成

**文件**: `app/agents/im_agent/tools.py` (13个工具)
**修改**: 无需修改工具实现，只需通过 `tool_bridge.py` 包装

```python
# 在 build_claude_agent() 中注册 IM 工具
from app.agents.im_agent.tools import (
    im_friend_add, im_message_send, im_group_create, ...
)
im_tools = [wrap_langchain_tool(t) for t in get_im_tools()]
```

### 4.2 通知系统
通知系统是独立的 REST API + Redis Pub/Sub，不依赖 Agent 引擎，**无需修改**。

### 4.3 对话管理
对话 CRUD（创建、列表、归档、删除）是纯 REST API，**无需修改**。
唯一关联点是 `CcMessage` 持久化 — 在 `adapter.py` 中完成 AI 消息的异步存储。

---

## Phase 5: 高级特性移植

### 5.1 意图识别保留
Super V5 的 3 层意图识别（规则 → Redis → LLM）仍然有价值：
- `DIRECT_ANSWER` → 用简单 LLM 调用（无工具），节省成本
- `TOOL_CALL` / `COMPLEX_PLAN` → 使用完整 ClaudeAgent

**方案**: 保留 `intent_router.py`，但将路由目标改为 ClaudeAgent 的不同配置：

```python
if intent == "DIRECT_ANSWER":
    agent = ClaudeAgent(tools=[], model="claude-haiku")  # 无工具，轻量模型
elif intent == "TOOL_CALL":
    agent = ClaudeAgent(tools=light_tools, model="claude-sonnet")  # 部分工具
else:
    agent = ClaudeAgent(tools=all_tools, model="claude-sonnet")  # 全部工具
```

### 5.2 MCP 工具动态加载
复用 Super V5 现有的 `MCPClientManager`，将 MCP 工具包装为 `ToolDef`。

### 5.3 计划执行引擎 (Plan Executor)
Super V5 的计划系统使用独立的 LangGraph 执行图。这部分**暂不替换**，保持原有实现，后续根据需要迁移。

---

## 关键文件清单

### 新建文件 (在 Super V5 中)
| 文件 | 行数估算 | 描述 |
|------|---------|------|
| `app/agents/claude_engine/__init__.py` | 20 | 公共 API 导出 |
| `app/agents/claude_engine/agent.py` | 400 | ClaudeAgent 类 |
| `app/agents/claude_engine/query_loop.py` | 500 | 核心 agentic 循环 |
| `app/agents/claude_engine/tool_base.py` | 250 | Tool 基类定义 |
| `app/agents/claude_engine/tool_registry.py` | 150 | 工具注册与过滤 |
| `app/agents/claude_engine/streaming_executor.py` | 200 | 并发工具执行 |
| `app/agents/claude_engine/tool_orchestration.py` | 100 | 工具批次分组 |
| `app/agents/claude_engine/token_budget.py` | 80 | Token 预算管理 |
| `app/agents/claude_engine/auto_compact.py` | 150 | 自动上下文压缩 |
| `app/agents/claude_engine/message_types.py` | 100 | 消息类型定义 |
| `app/agents/claude_engine/system_prompt.py` | 200 | 系统提示词组装 |
| `app/agents/claude_engine/adapter.py` | 300 | Super V5 适配层 |
| `app/agents/claude_engine/tool_bridge.py` | 100 | LangChain 工具桥接 |
| `app/agents/claude_engine/errors.py` | 80 | 错误分类 |
| **合计** | **~2,630** | |

### 修改文件 (在 Super V5 中)
| 文件 | 修改范围 | 描述 |
|------|---------|------|
| `app/agents/carys_agent/entry.py` | +15 行 | 添加特性开关 → ClaudeAgent |
| `app/agents/executor/chat_stream_runner.py` | +20 行 | 识别 ClaudeAgent 类型并适配流式 |
| `app/core/config.py` | +10 行 | 新增配置项 |
| `app/api/v1/endpoints/websocket_chat.py` | +5 行 | 透传新参数（可选） |

### 不修改的文件
- 全部 200+ API 端点文件
- 全部数据库模型
- 全部工具实现 (IM、任务、文档、SDLC)
- 全部中间件（逐步废弃而非修改）
- WebSocket 连接管理器
- Redis/Kafka 基础设施

---

## 验证方案

### 1. 单元验证
```bash
# 在 superv5/ 目录下
python -c "
from app.agents.claude_engine import ClaudeAgent, ToolDef
agent = ClaudeAgent(tools=[], system_prompt='你是AI助手')
import asyncio
async def test():
    async for event in agent.submit_message('你好'):
        print(event)
asyncio.run(test())
"
```

### 2. 集成验证
- 启动 Super V5 服务 (`CLAUDE_ENGINE_ENABLED=true`)
- 使用前端发送聊天消息
- 验证 WebSocket 事件格式与原有格式一致
- 验证工具调用（如发送 IM 消息）正常执行
- 验证消息持久化到 `cc_messages` 表

### 3. 回滚验证
- 设置 `CLAUDE_ENGINE_ENABLED=false`
- 验证完全回退到 LangGraph 引擎
- 无任何功能影响

### 4. 性能对比
- 对比新旧引擎的首 token 延迟
- 对比多工具调用场景的总耗时
- 监控 Langfuse 中的 token 使用量

---

## 实施顺序

```
Phase 0 (准备)     → 0.5 天
Phase 1 (核心引擎) → 3-4 天 (最关键，需要仔细移植)
Phase 2 (适配层)   → 1-2 天
Phase 3 (接入替换) → 0.5 天 (最小修改，风险最低)
Phase 4 (IM/通知)  → 1 天 (主要是工具注册)
Phase 5 (高级特性) → 2-3 天 (按需)
```

## 风险与缓解

| 风险 | 缓解措施 |
|------|---------|
| 新引擎行为不一致 | 特性开关 `CLAUDE_ENGINE_ENABLED` 支持随时回滚 |
| 流式事件格式不匹配 | adapter.py 专门做格式转换，有测试覆盖 |
| 工具调用异常 | tool_bridge.py 包装层捕获异常，返回错误 tool_result |
| Token 成本增加 | 保留意图路由，简单问题用轻量模型 |
| 计划执行引擎受影响 | Phase 5 才处理，暂时保持 LangGraph |
