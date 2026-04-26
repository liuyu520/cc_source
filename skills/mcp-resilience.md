# MCP 工具弹性机制

## 问题根因

MCP 客户端连接断开后工具调用失败: `Client failed to connect: All connection attempts failed`

链路: `MCPClientManager` 缓存工具 (TTL 30min) → 底层 HTTP 连接断开 → 缓存的 LangChain tool 内部 session 失效 → 工具调用失败 → 无重连机制

## 架构约束

`langchain_mcp_adapters` v0.2.1 的 `MultiServerMCPClient`:
- **每次工具调用创建独立临时 session** (connect → initialize → call_tool → disconnect)
- **无** `onclose`/`onerror` 回调
- **无** 长连接管理

因此 Claude Code 的"事件驱动缓存清理"(`onclose` → clear cache) 模式**无法直接套用**。

## 三层防御设计

### 层 1: 精确错误分类 (errors.py)

对齐 Claude Code `isTerminalConnectionError()` + `isMcpSessionExpiredError()`:

```python
class McpErrorType(str, Enum):
    CONNECTION_REFUSED = "connection_refused"    # 服务端不可用
    TIMEOUT = "timeout"                          # 网络超时
    SESSION_EXPIRED = "session_expired"          # MCP -32001
    CONNECTION_CLOSED = "connection_closed"      # ECONNRESET/EPIPE
    AUTH_ERROR = "auth_error"                    # 401
    UNKNOWN = "unknown"

def classify_mcp_error(exc) -> McpErrorType:
    # 优先级: session_expired > auth > conn_refused > timeout > conn_closed > unknown
```

### 层 2: 差异化恢复 (tool_bridge.py)

| 错误类型 | 恢复策略 | 对齐 Claude Code |
|----------|---------|------------------|
| `SESSION_EXPIRED` / `CONNECTION_CLOSED` / `TIMEOUT` | invalidate cache → reload tools → 重试 1 次 | `McpSessionExpiredError` → retry with `ensureConnectedClient` |
| `CONNECTION_REFUSED` | 记录熔断, 快速失败, 不重连 | 终端错误 → `closeTransportAndRejectPending` |
| `AUTH_ERROR` | 记录错误, 不重连 | `McpAuthError` → set status `needs-auth` |

重连流程:
```
工具调用失败
  → classify_mcp_error() 分类
  → 可重连类型? → _try_mcp_reconnect()
    → 获取去抖锁
    → should_invalidate? → MCPClientManager.invalidate_cache()
    → _load_filtered_mcp_tools() 获取新工具
    → 按 name 匹配 → 替换 self._lc_tool → 重试
```

去抖机制: 10 秒窗口内只执行一次 `invalidate_cache()`, 后续并发请求直接获取新工具。

### 层 3: 工具级熔断器 (circuit_breaker.py)

```python
mcp_tool_breaker = CircuitBreaker("mcp_tool", failure_threshold=3, recovery_timeout=30)
```

在 `call()` 方法最前面 (cheapest first):
```python
if self._is_mcp_tool and not mcp_tool_breaker.allow_request():
    return ToolResult(content="MCP service temporarily unavailable", is_error=True)
```

当 MCP 服务端持续不可用时, 3 次失败后熔断, 30 秒冷却期内所有 MCP 工具快速失败。

## MCP 工具识别

```python
self._is_mcp_tool = (
    "mcp" in type(lc_tool).__module__.lower()
    or hasattr(lc_tool, "server_name")
    or "mcp" in self.name.lower()
)
```

## 重连回调注册 (entry.py)

```python
async def _mcp_reconnect_fn(tool_name, should_invalidate=True):
    if should_invalidate:
        await manager.invalidate_cache()
    fresh_tools = await _load_filtered_mcp_tools(set())
    for t in fresh_tools:
        if t.name == tool_name:
            return t
    return None

LangChainToolWrapper.set_mcp_reconnect_fn(_mcp_reconnect_fn)
```

## 关键文件

| 文件 | 职责 |
|------|------|
| `errors.py` | `McpErrorType` 枚举 + `classify_mcp_error()` 精确分类 |
| `tool_bridge.py` | `LangChainToolWrapper` — 熔断检查, 精确分类, 差异化恢复, 重连去抖 |
| `circuit_breaker.py` | `mcp_tool_breaker` 全局实例 |
| `entry.py` | 注册 `_mcp_reconnect_fn` 回调 |
| `mcp_client_manager.py` | `MCPClientManager` 缓存管理, `invalidate_cache()` |

## Claude Code 对标

| Claude Code 模式 | SuperV5 适配 |
|------------------|-------------|
| `onclose` → 清理所有缓存 | 工具调用失败时 `invalidate_cache()` (被动, 因 SDK 无 onclose) |
| `ensureConnectedClient()` → 自动重建 | `_try_mcp_reconnect()` → 获取新工具替换旧引用 |
| `MAX_ERRORS_BEFORE_RECONNECT = 3` 连续错误计数 | `mcp_tool_breaker` 熔断器 (threshold=3) |
| `McpSessionExpiredError` → retry 1 次 | `_MCP_RECONNECTABLE_TYPES` → 重连+重试 1 次 |
| `hasTriggeredClose` 防重入 | `_reconnect_lock` + `_last_reconnect_time` 去抖 |

## 关联 Skill

- **mcp-osv-malware-detection** — 连接前的恶意包检测（OSV 数据库扫描），与本 skill 的连接后错误恢复互补，共同构成 MCP 生命周期完整安全保障
