import { AGENT_TOOL_NAME } from '../../tools/AgentTool/constants.js'
import { registerBundledSkill } from '../bundledSkills.js'

const TOOL_BRIDGE_PROMPT = `# /tool-bridge — 跨框架工具桥接

将一个 AI 框架的工具（LangChain @tool、OpenAI function_call、Anthropic tool_use、MCP tools、自定义工具等）包装为另一个框架的工具格式，实现零修改复用。

## 适用场景

- LangChain @tool → Anthropic ToolDef (Python/TypeScript)
- OpenAI Function Calling → Anthropic tool_use
- MCP Tools → 原生工具格式
- 自定义函数 → 标准化工具接口
- 任何"保留工具实现、只换调用壳"的场景

## Phase 1: 工具生态盘点

使用 ${AGENT_TOOL_NAME} 启动 Explore agent 扫描项目中所有现有工具:

\`\`\`
搜索模式:
- Python: @tool 装饰器, BaseTool 子类, StructuredTool.from_function
- TypeScript: Tool 类, buildTool(), toolDefinition
- MCP: tool_list(), tools/list handler
\`\`\`

产出表格:

| 工具名 | 框架 | 文件位置 | 参数类型 | 返回类型 | 是否并发安全 | 分类 |
|--------|------|---------|---------|---------|------------|------|
| send_im_message | LangChain @tool | agents/im/tools.py | dict | str | ✅ | IM |
| create_task | LangChain @tool | agents/task/tools.py | TaskInput | str | ❌ | 任务 |
| ... | ... | ... | ... | ... | ... | ... |

## Phase 2: 确定目标工具接口

分析目标 Agent 引擎的工具接口要求:

\`\`\`python
# 典型的目标接口 (Python Anthropic 风格)
class ToolDef:
    name: str
    description: str
    input_schema: dict  # JSON Schema

    async def call(self, args: dict, context: ToolUseContext) -> ToolResult
    def to_api_schema(self) -> dict  # Anthropic API 格式
\`\`\`

需要映射的字段:
1. **name** — 工具名 (通常可直接取)
2. **description** — 工具描述 (从 docstring 或 description 属性)
3. **input_schema** — 参数 schema (Pydantic → JSON Schema, Zod → JSON Schema)
4. **call()** — 执行函数 (包装原有调用: ainvoke/invoke/_run/_arun)
5. **并发安全标记** — 是否可并行执行

## Phase 3: 实现桥接层

### 3.1 核心包装函数

\`\`\`python
# Python 示例: LangChain → Anthropic ToolDef
def wrap_langchain_tool(lc_tool) -> ToolDef:
    """
    关键映射:
    - lc_tool.name → ToolDef.name
    - lc_tool.description → ToolDef.description
    - lc_tool.args_schema.model_json_schema() → ToolDef.input_schema
    - lc_tool.ainvoke(args) → ToolDef.call(args, ctx)
    """
\`\`\`

### 3.2 参数 Schema 转换

不同框架的 schema 格式差异:

| 源框架 | Schema 格式 | 转换方式 |
|--------|-----------|---------|
| LangChain (Pydantic) | Pydantic BaseModel | .model_json_schema() |
| LangChain (无schema) | 无 | 构建 {"type":"object","properties":{}} |
| Zod (TypeScript) | Zod Schema | zodToJsonSchema() |
| MCP | JSON Schema | 直接使用 |
| OpenAI | JSON Schema | 直接使用 |
| 自定义 (type hints) | Python type hints | 手动构建 JSON Schema |

### 3.3 调用方式适配

\`\`\`python
# LangChain 工具的 3 种调用方式，按优先级:
async def _call_langchain_tool(lc_tool, args: dict):
    # 1. 异步优先
    if hasattr(lc_tool, 'ainvoke'):
        return await lc_tool.ainvoke(args)
    # 2. 协程 _arun
    if hasattr(lc_tool, '_arun'):
        return await lc_tool._arun(**args)
    # 3. 同步回退 (在线程池执行，避免阻塞事件循环)
    import asyncio
    return await asyncio.get_event_loop().run_in_executor(
        None, lambda: lc_tool.invoke(args)
    )
\`\`\`

### 3.4 结果标准化

\`\`\`python
def _normalize_result(raw_result) -> ToolResult:
    """
    不同工具返回类型不同:
    - str → 直接使用
    - dict → json.dumps
    - BaseModel → .model_dump_json()
    - ToolMessage → .content
    - Exception → ToolResult(content=str(e), is_error=True)
    """
\`\`\`

### 3.5 批量包装

\`\`\`python
def wrap_langchain_tools(lc_tools: list) -> list[ToolDef]:
    """批量包装 + 去重 + 日志"""
    wrapped = []
    seen_names = set()
    for tool in lc_tools:
        if tool.name in seen_names:
            logger.warning("跳过重复工具: %s", tool.name)
            continue
        wrapped.append(wrap_langchain_tool(tool))
        seen_names.add(tool.name)
    return wrapped
\`\`\`

## Phase 4: 工具注册表

\`\`\`python
class ToolRegistry:
    """集中管理所有工具，支持按分类/名称过滤"""

    def register_langchain_tools(self, lc_tools, category="default"):
        """批量注册 LangChain 工具"""

    def get_tools_by_category(self, category) -> list[ToolDef]:
        """按分类获取工具 (IM, 文档, SDLC ...)"""

    def filter_tools(self, suggested_tools) -> list[ToolDef]:
        """按意图识别结果过滤工具集"""
\`\`\`

## Phase 5: 验证

### 5.1 Schema 验证
\`\`\`python
for tool in wrapped_tools:
    schema = tool.to_api_schema()
    assert "name" in schema
    assert "description" in schema
    assert "input_schema" in schema
    # 确保 Anthropic API 接受这个 schema
\`\`\`

### 5.2 调用验证
对每类工具至少测试一个:
- 传入正确参数 → 返回正常结果
- 传入错误参数 → 返回 is_error=True (不是抛异常)
- 异步调用不阻塞事件循环

### 5.3 集成验证
通过 Agent 引擎实际调用桥接工具:
- LLM 能正确理解工具描述并选择使用
- 工具参数被正确解析
- 工具结果被正确追加到消息历史

## 常见陷阱

1. **args_schema 为 None** — 有些 LangChain 工具没有 args_schema，需要动态构建空 schema
2. **同步工具阻塞事件循环** — 必须用 run_in_executor 包装
3. **工具名冲突** — 不同模块的工具可能同名，需要去重或命名空间
4. **返回类型不一致** — str/dict/BaseModel/ToolMessage 都可能出现
5. **schema 中的 $defs** — Pydantic v2 生成的 schema 包含 $defs 引用，某些 API 不支持
6. **description 过长** — 工具描述超过 API 限制 (通常 4096 字符) 需截断
`

export function registerToolBridgeSkill(): void {
  registerBundledSkill({
    name: 'tool-bridge',
    description:
      'Create a tool bridge layer to wrap tools from one AI framework (LangChain, OpenAI, MCP) for use in another, with zero modification to tool implementations.',
    aliases: ['bridge-tools'],
    userInvocable: true,
    async getPromptForCommand(args) {
      let prompt = TOOL_BRIDGE_PROMPT
      if (args) {
        prompt += `\n## Bridge Target\n\n${args}`
      }
      return [{ type: 'text', text: prompt }]
    },
  })
}
