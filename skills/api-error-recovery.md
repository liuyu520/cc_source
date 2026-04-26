# API 错误分类与恢复

## 核心模式: 精确分类 + 差异化恢复

对齐 Claude Code `withRetry.ts` (src/services/api/withRetry.ts:170-550) 的错误处理级联。

## 错误分类 (errors.py)

### 优先使用 HTTP status_code

```python
def classify_api_error(error: Exception) -> QueryErrorType:
    import anthropic

    # 精确路径: SDK 异常类型
    if isinstance(error, anthropic.APIStatusError):
        if error.status_code == 413: return PROMPT_TOO_LONG
        if error.status_code == 429: return RATE_LIMIT
        if error.status_code == 529: return MODEL_OVERLOADED
        if error.status_code == 401: return AUTH_ERROR
        if error.status_code == 400:
            # 400 子类型: context overflow vs extra inputs vs prompt too long
            ...
        if error.status_code >= 500: return API_ERROR  # 5xx 可重试

    if isinstance(error, anthropic.APIConnectionError):
        return NETWORK_ERROR

    # 兜底: 字符串匹配
    ...
```

### 为什么不能只用字符串匹配

旧代码 `"429" in error_str` 可能匹配到非 HTTP 429 的内容 (如错误消息中包含 "429" 字样)。

`anthropic.APIStatusError.status_code` 是精确的 HTTP 状态码, 不会误匹配。

## 错误类型与恢复策略

| 错误类型 | HTTP | 恢复策略 | 对齐 Claude Code |
|----------|------|---------|------------------|
| `PROMPT_TOO_LONG` | 413 | 强制 compact → 重试 (上限 3 次) | query.ts line 1104 |
| `RATE_LIMIT` | 429 | retry-after 或指数退避 → 重试 | withRetry.ts line 429 |
| `MODEL_OVERLOADED` | 529 | 指数退避 → 重试 | withRetry.ts line 318 |
| `AUTH_ERROR` | 401 | **不重试**, 直接终止 | withRetry.ts line 233 |
| `CONTEXT_OVERFLOW` | 400 | 强制 compact → 重试 | withRetry.ts line 388 |
| `NETWORK_ERROR` | - | 指数退避 → 重试 | withRetry.ts `APIConnectionError` |
| `API_ERROR` | 5xx | 终止 (无降级模型) | withRetry.ts line 318 |

## 指数退避 + 随机抖动

对齐 Claude Code `computeDelay()`:

```python
def _exponential_backoff(attempt, base=1.0, cap=32.0):
    import random
    delay = min(base * (2 ** attempt), cap)
    jitter = random.random() * 0.25 * delay
    return delay + jitter
```

| 重试次数 | 基础延迟 | 含抖动范围 |
|----------|---------|-----------|
| 1 | 2s | 2.0-2.5s |
| 2 | 4s | 4.0-5.0s |
| 3 | 8s | 8.0-10.0s |

优先使用 API 返回的 `retry-after` header (RATE_LIMIT 场景), 否则用指数退避。

## APIConnectionError 处理

Claude Code 专门处理 `APIConnectionError` (网络级错误):
- `ECONNRESET` / `EPIPE` → 禁用 HTTP keep-alive, 强制创建新客户端
- 其他 → 指数退避重试

SuperV5 适配:
```python
except anthropic.APIConnectionError as e:
    api_retry_count += 1
    if api_retry_count > MAX_API_RETRIES:
        yield error event; return
    delay = _exponential_backoff(api_retry_count)
    await asyncio.sleep(delay)
    continue
```

## 不做的事 (SuperV5 不需要)

| Claude Code 特性 | 为什么不需要 |
|------------------|-------------|
| Fast mode fallback | SuperV5 不支持快速模式 |
| Model fallback (FallbackTriggeredError) | SuperV5 单一模型 |
| Persistent retry (无人值守) | SuperV5 非无人值守场景 |
| OAuth token refresh (401 → re-auth) | SuperV5 使用 API Key, 非 OAuth |
| 529 background suppression | SuperV5 无后台查询源 |

## 关键文件

| 文件 | 职责 |
|------|------|
| `errors.py` | `QueryErrorType` 枚举 + `classify_api_error()` 精确分类 |
| `query_loop.py` | `_exponential_backoff()` + 各错误类型的恢复分支 |
| `circuit_breaker.py` | `llm_api_breaker` 全局实例 (连续 3 次失败 → 60s 熔断) |

## Claude Code 对标

| Claude Code | SuperV5 |
|-------------|---------|
| `withRetry()` AsyncGenerator | `query_loop()` 内 try/except 级联 |
| `shouldRetry()` 决策树 | `classify_api_error()` + 各分支 |
| `computeDelay()` 指数退避 | `_exponential_backoff()` |
| `FallbackTriggeredError` | 不实现 (单一模型) |
| `CannotRetryError` | yield ERROR event + return |
