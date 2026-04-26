# Claude Code HTTP/SSE LLM 服务设计

- 日期：2026-04-16
- 作者：brainstorming (人机协作确认)
- 状态：Design approved，待实施规划
- 关联：复用 `src/services/api/{claude,client}.ts`、`src/query.ts`、`src/services/daemon/`、`src/entrypoints/cli.tsx` `--daemon-worker` fast-path

---

## 1. 背景

Claude Code CLI 当前只提供交互式 REPL（Ink TUI），外部程序无法通过标准 HTTP 协议调用其底层 LLM 能力。用户希望：

1. 每次启动 Claude Code CLI 时自动拉起一个**全局 HTTP 服务**（固定端口 **6646**）
2. 重复启动 CLI 时检测已有实例，**不重复绑定端口**
3. HTTP 服务以 **SSE 协议**提供 LLM 对话能力
4. 最大化**复用已有逻辑**，不重新造轮子

## 2. 目标 & 非目标

### 2.1 目标

- 全局单例 HTTP 服务，CLI 启动即自启、退出不影响（detached）
- 同时兼容 **OpenAI `/v1/chat/completions`** 和 **Anthropic 原生 `/v1/messages`** 两种协议，按路径路由
- 复用 `src/services/api/client.ts` 的 SDK 创建逻辑（天然支持 `ANTHROPIC_BASE_URL` / Bedrock / Vertex / 第三方 API）
- 用 Bun 自带的 `Bun.serve()` 实现，不引入 express/fastify
- 复用 `src/entrypoints/cli.tsx` 已预留的 `--daemon-worker=<kind>` fast-path 派生子进程

### 2.2 非目标（Out of scope）

- 不提供管理面板 / UI
- 不做多租户、不做账单、不做 rate limiting（内网单机场景）
- 不持久化对话历史（每次请求独立）
- 不提供音频 / voice / 图像输入输出（只做文本）
- 不改动现有 REPL / CLI 命令行为

## 3. 决策总结（用户确认过）

| 维度 | 决策 | 备注 |
|---|---|---|
| API 协议 | **双协议**：`/v1/chat/completions`(OpenAI) + `/v1/messages`(Anthropic)，按路径分流 | OpenAI 侧需写 messages/SSE 转换层；Anthropic 侧透传 |
| 进程模型 | **detached 后台子进程**，写 PID lockfile | 真"全局单例"，CLI 退出服务继续跑 |
| 功能深度 | **混合模式**：默认纯 LLM 透传；body `tools=true` 或 header `x-claude-tools:1` 时进 agent loop | agent loop 默认关闭，必须 `CLAUDE_HTTP_SERVER_TOOLS_ENABLED=1` 显式打开 |
| 绑定 & 鉴权 | `0.0.0.0` + **随机 32-byte hex token**（`Authorization: Bearer`） | token 写入 `~/.claude/http-server.json` 供同主机调用方读取；`/healthz` 不鉴权 |
| 默认开关 | `CLAUDE_HTTP_SERVER_ENABLED=1`（**默认启用**） | 用户可设 `0` 关闭 |
| 单例实现 | 复用 `cli.tsx` 已存在的 `--daemon-worker=<kind>` fast-path，新建 `src/daemon/workerRegistry.ts` 并在其中注册 `http-server` kind | "填槽"方案，贴合项目现有 supervisor spawns 约定 |

## 4. 架构总览

### 4.1 进程拓扑

```
┌─ 用户运行 claude-code CLI ─────────────────────────────────┐
│                                                            │
│  bootstrap-entry.ts → entrypoints/cli.tsx → main.tsx       │
│                                  │                         │
│  main.tsx init 钩子 → ensureHttpServerRunning()            │
│          ├─ env=0 → {disabled}，跳过                       │
│          ├─ 读 ~/.claude/http-server.json + probe :6646    │
│          │    ├─ 已运行 → {already-running}                │
│          │    └─ stale → 删 lockfile，继续                 │
│          └─ Bun.spawn([bun, bootstrap-entry.ts,            │
│                '--daemon-worker','http-server'],           │
│                { detached:true, stdio:'ignore',            │
│                  env:{...process.env,                      │
│                        CLAUDE_HTTP_SERVER_WORKER:'1' }     │
│              }).unref()                                    │
│          → 轮询 lockfile+healthz (3s) 确认启动             │
│          → 返回 {spawned, pid, port}                       │
│  CLI 继续原有 REPL 流程 (不被阻塞)                         │
└────────────────────────────────────────────────────────────┘

┌─ 后台 HTTP daemon (独立 bun 进程) ─────────────────────────┐
│  cli.tsx:100 fast-path → runDaemonWorker('http-server')    │
│    → src/services/httpServer/workerEntry.ts               │
│       ├─ 生成 32-byte hex token                           │
│       ├─ Bun.serve({ hostname:'0.0.0.0', port:6646,       │
│       │             fetch: createFetchHandler(ctx) })     │
│       ├─ 写 ~/.claude/http-server.json                    │
│       ├─ signal-exit 注册 (SIGTERM/SIGINT → 清 lockfile)  │
│       └─ 等 Bun.serve (进程不退)                          │
│                                                            │
│  fetch handler 路由：                                      │
│    GET  /healthz              → 公开                       │
│    GET  /v1/models            → 鉴权 → 透传                │
│    POST /v1/chat/completions  → 鉴权 → OpenAI 适配层       │
│    POST /v1/messages          → 鉴权 → Anthropic 原生透传 │
│    POST /shutdown             → 鉴权 → 优雅停止            │
└────────────────────────────────────────────────────────────┘
```

### 4.2 请求分发（三条路径）

#### 路径 1：`POST /v1/chat/completions`（OpenAI 兼容）

```
client POST {model, messages, stream, tools?}
  ↓ 校验 Bearer token (timingSafeEqual)
  ↓ openaiRequestToAnthropic(body): system/user/assistant 消息格式 + tools 互转
  ↓ 复用 src/services/api/client.ts createClient() → anthropic.messages.stream(params)
  ↓ anthropicStreamToOpenaiSSE(stream):
      - message_start        → data:{id, object:"chat.completion.chunk", choices:[{delta:{role:"assistant"}}]}
      - content_block_delta  → data:{choices:[{delta:{content:delta.text}}]}
      - message_stop         → data:{choices:[{finish_reason:"stop"}]} + data:[DONE]
  ↓ Response(ReadableStream, headers:{content-type:'text/event-stream', cache-control:'no-cache', connection:'keep-alive'})
```

非 stream 请求：消费完 stream 后合成 OpenAI 非 stream response 返回 JSON。

#### 路径 2：`POST /v1/messages`（Anthropic 原生）

```
client POST {model, messages, stream, ...Anthropic params}
  ↓ 校验 token
  ↓ anthropic.messages.stream(body)  (透传)
  ↓ for-await ev of stream:
      write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`)
  ↓ Response(text/event-stream)
```

#### 路径 3：`tools=true`（agent loop，两协议共用）

```
body.tools === true  或  header x-claude-tools:1
  ↓ 护栏 1: CLAUDE_HTTP_SERVER_TOOLS_ENABLED !== '1' → 403 "tools disabled"
  ↓ 护栏 2: remoteAddress !∈ {127.0.0.1, ::1, ::ffff:127.0.0.1} → 403 "tools only on loopback"
  ↓ 动态 import { query } from src/query.ts
     - 最小 ToolsetContext（白名单：Bash/FileEdit/Grep/Read/Glob；禁用 WebFetch/WebSearch/MCP）
     - workingDir = process.env.CLAUDE_HTTP_SERVER_CWD ?? process.cwd()
     - AbortSignal 绑定到 Response close（客户端断连立即中止）
  ↓ 遍历 query 产出 message/tool_use/tool_result → SSE
  ↓ Response(text/event-stream)
```

## 5. 文件清单

### 5.1 新增（6 个文件）

| 路径 | 职责 | 规模估算 |
|---|---|---|
| `src/services/httpServer/index.ts` | 对外 API：`ensureHttpServerRunning()` / `getHttpServerStatus()` / `isHttpServerEnabled()` | ~120 行 |
| `src/services/httpServer/lockfile.ts` | `~/.claude/http-server.json` 读写 + stale 检测（pid kill(0) + healthz HEAD） | ~80 行 |
| `src/services/httpServer/workerEntry.ts` | daemon 子进程入口；启动 Bun.serve、生成 token、注册退出清理 | ~100 行 |
| `src/services/httpServer/routes.ts` | Bun.serve fetch handler；路由分发 + token 校验 | ~150 行 |
| `src/services/httpServer/adapters/openaiAdapter.ts` | OpenAI⇔Anthropic 消息格式和 SSE 事件互转 | ~200 行 |
| `src/daemon/workerRegistry.ts` | **新建**（cli.tsx:103 的 import 此前悬空）；switch 分派 `runDaemonWorker(kind)` | ~30 行 |

### 5.2 修改（1 个文件）

| 路径 | 改动 |
|---|---|
| `src/main.tsx` | init 路径内（auth/policy/REPL 启动前）追加一行 `ensureHttpServerRunning()`，fire-and-forget，失败仅 `logForDebugging` 不抛 |

### 5.3 不动的文件

- `src/entrypoints/cli.tsx` —— 已有 `--daemon-worker` fast-path (100-106)，直接复用
- `src/services/api/{client,claude}.ts` —— 复用 SDK 客户端创建和流式调用
- `src/query.ts` / `src/QueryEngine.ts` —— 仅 tools 路径动态 import 使用
- `src/services/daemon/daemon.ts` —— 与本功能解耦，不混用

## 6. 组件接口（TypeScript 签名）

### 6.1 `src/services/httpServer/index.ts`

```ts
export interface LockInfo {
  pid: number
  port: number
  host: string
  token: string
  startedAt: number
  version: string
}

export type EnsureResult =
  | { status: 'already-running'; info: LockInfo }
  | { status: 'spawned'; pid: number; port: number }
  | { status: 'disabled'; reason: string }
  | { status: 'failed'; error: string }

export async function ensureHttpServerRunning(): Promise<EnsureResult>
export function getHttpServerStatus(): LockInfo | null
export function isHttpServerEnabled(): boolean
```

### 6.2 `src/services/httpServer/lockfile.ts`

```ts
export function getLockfilePath(): string  // ~/.claude/http-server.json
export function readLockfile(): LockInfo | null
export function writeLockfile(info: LockInfo): void
export function deleteLockfile(): void
export async function isLockStale(info: LockInfo, timeoutMs?: number): Promise<boolean>
```

### 6.3 `src/services/httpServer/workerEntry.ts`

```ts
export async function runHttpServerWorker(): Promise<void>
// 内部：readEnvSnapshot → genToken → Bun.serve → writeLockfile → registerExitCleanup → 挂起
```

### 6.4 `src/services/httpServer/routes.ts`

```ts
export interface ServerContext {
  token: string
  upstreamSdk: Anthropic      // 复用 createClient()
  startedAt: number
  version: string
}
export function createFetchHandler(ctx: ServerContext): (req: Request, server: BunServer) => Promise<Response>
```

### 6.5 `src/services/httpServer/adapters/openaiAdapter.ts`

```ts
export interface OpenAIChatRequest { model: string; messages: OpenAIMessage[]; stream?: boolean; tools?: any[]; temperature?: number; max_tokens?: number; ... }
export function openaiRequestToAnthropic(body: OpenAIChatRequest): Anthropic.MessageCreateParams
export async function* anthropicStreamToOpenaiSSE(
  stream: AsyncIterable<Anthropic.MessageStreamEvent>,
  requestId: string,
  model: string
): AsyncIterable<string>  // 产出 `data: {...}\n\n` 行，末尾 `data: [DONE]\n\n`
export async function anthropicResultToOpenaiJson(
  stream: AsyncIterable<Anthropic.MessageStreamEvent>,
  requestId: string,
  model: string
): Promise<OpenAIChatResponse>  // 非 stream 响应聚合
```

### 6.6 `src/daemon/workerRegistry.ts`（新建）

```ts
export async function runDaemonWorker(kind: string): Promise<void> {
  switch (kind) {
    case 'http-server': {
      const { runHttpServerWorker } = await import('../services/httpServer/workerEntry.js')
      return runHttpServerWorker()
    }
    default:
      throw new Error(`unknown daemon worker kind: ${kind}`)
  }
}
```

## 7. 运行时细节

### 7.1 单例互斥算法

```
function ensureHttpServerRunning():
  1. if !isHttpServerEnabled() → {disabled, reason:"env CLAUDE_HTTP_SERVER_ENABLED=0"}
  2. if args 命中 fast-path (--version / -v / --dump-system-prompt / --daemon-worker /
                             --chrome-native-host / --claude-in-chrome-mcp / --computer-use-mcp)
       → {disabled, reason:"fast-path startup"}   // 保持启动零开销
  3. info = readLockfile()
     if info:
       a. if !processAlive(info.pid) → deleteLockfile(), 继续
       b. if !await healthzProbe(info.port, 2s) → deleteLockfile(), 继续
       c. else → {already-running, info}
  4. child = Bun.spawn(
       [process.execPath, resolve('src/bootstrap-entry.ts'),
        '--daemon-worker', 'http-server'],
       { detached:true, stdio:['ignore','ignore','ignore'],
         env: { ...process.env, CLAUDE_HTTP_SERVER_WORKER:'1' } }
     )
     child.unref()
  5. 轮询 readLockfile() + healthzProbe 最多 3s（每 200ms 一次）
     success → {spawned, pid, port}
     timeout → {failed, error:"daemon did not report ready in 3s"}
```

- **不用 `proper-lockfile` 文件锁** —— detached 进程持锁到死不适合。lockfile 只是状态快照；并发 CLI 启动双保险由 `Bun.serve` 的 `EADDRINUSE` 兜底
- **race condition**：两个 CLI 同时启动、同时读到 lockfile 不存在 → 都 spawn。第二个子进程 `Bun.serve` 会抛 `EADDRINUSE`，自觉退出 + 不写 lockfile；第一个成功写 lockfile

### 7.2 健康探测 (healthzProbe)

```ts
async function healthzProbe(port: number, timeoutMs = 2000): Promise<boolean> {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: ctrl.signal })
    clearTimeout(t)
    return res.ok
  } catch { return false }
}
```

### 7.3 子进程配置继承

- `Bun.spawn({ env: { ...process.env } })` 天然继承所有 `ANTHROPIC_*`、`CLAUDE_*`、`HTTP_PROXY` 等环境变量
- daemon 子进程启动后**不再读 `~/.claude/settings.json`**（避免并发写冲突）
- **trade-off**：用户若想切换上游（换 BASE_URL / 模型），必须显式 kill 后台 daemon 后让新 CLI 启动重新 spawn

### 7.4 生命周期事件

| 事件 | 行为 |
|---|---|
| daemon 启动成功 | writeLockfile，`logForDebugging('[http-server] listening on {host}:{port}')` |
| SIGTERM / SIGINT | deleteLockfile，关闭 Bun.serve，`process.exit(0)` |
| `uncaughtException` / `unhandledRejection` | 写 `~/.claude/http-server.log`，**不退出** |
| `Bun.serve` 绑定失败（EADDRINUSE 或权限） | 不写 lockfile，`process.exit(1)` |
| 客户端断连中途 | `req.signal.aborted` → 中止上游 stream + agent loop |
| daemon 自身宕机 | lockfile 残留，下次 CLI 启动会在 isLockStale 检测中发现 pid 死亡并清理 |

### 7.5 端点清单

| 端点 | 方法 | 鉴权 | 描述 |
|---|---|---|---|
| `/healthz` | GET | ❌ | `{ ok:true, pid, port, host, version, uptimeMs }` |
| `/v1/models` | GET | ✅ | `{ object:"list", data:[{id:model, object:"model", owned_by:"claude-code"}] }` |
| `/v1/chat/completions` | POST | ✅ | OpenAI 兼容；`stream:true` → SSE；否则 JSON |
| `/v1/messages` | POST | ✅ | Anthropic 原生；透传 |
| `/shutdown` | POST | ✅ | 优雅停止（`deleteLockfile + exit 0`）；供 CLI 主进程或运维调用 |
| 其它路径 | 任意 | — | 404 |

### 7.6 错误响应约定

| 情形 | HTTP 码 | body (OpenAI 路径) | body (Anthropic 路径) |
|---|---|---|---|
| 鉴权失败 | 401 | `{error:{message:"unauthorized", type:"invalid_request_error"}}` | `{type:"error", error:{type:"authentication_error", message:"unauthorized"}}` |
| body 解析失败 | 400 | `{error:{message:"invalid json", type:"invalid_request_error"}}` | `{type:"error", error:{type:"invalid_request_error", message:"..."}}` |
| tools 被禁 | 403 | 同上格式 + message="tools disabled by server config" | 同上格式 |
| tools 非 loopback | 403 | message="tools only allowed on loopback" | |
| 上游 SDK 报错 | 502 | OpenAI 错误格式 | Anthropic 错误格式（透传 `error.type`） |
| SSE 中途出错 | 已 200 | `event: error\ndata: {...}\n\n` 后关闭 | 同上 |

## 8. 安全模型

### 8.1 纯透传路径（默认）

- 绑定 `0.0.0.0:6646` 暴露局域网
- 所有非 `/healthz` 端点必须带 `Authorization: Bearer <token>`（timingSafeEqual 常量时比较）
- token 32-byte hex 随机，daemon 启动时生成；写入 `~/.claude/http-server.json`，文件权限 `0600`（仅当前用户读）

### 8.2 Agent loop 路径（tools=true）

**多重护栏**：

1. **构建时默认关**：`CLAUDE_HTTP_SERVER_TOOLS_ENABLED` 默认 `0`，必须显式 `=1` 才允许
2. **运行时绑定检查**：即使 env 已开，若请求的 `remoteAddress` 不在 `{127.0.0.1, ::1, ::ffff:127.0.0.1}` 白名单 → 403
3. **工具白名单**：只暴露 `Bash` / `FileEdit` / `Read` / `Grep` / `Glob`；禁用 `WebFetch` / `WebSearch` / `MCP` / `Agent`（子 agent 递归）
4. **工作目录**：`process.env.CLAUDE_HTTP_SERVER_CWD ?? process.cwd()`；Bash/FileEdit 在该目录作用域

### 8.3 token 失窃场景

同主机其他用户能读 `~/.claude/http-server.json` → 能调用 LLM 浪费额度，但（因为 tools 路径有 loopback 硬检查 + 默认关）**不会导致远程命令执行**。

## 9. 环境变量

| 变量 | 默认 | 作用 | 读取方 |
|---|---|---|---|
| `CLAUDE_HTTP_SERVER_ENABLED` | `1` | 总开关；设 `0` 完全禁用 | `index.ts` |
| `CLAUDE_HTTP_SERVER_PORT` | `6646` | 绑定端口（用户一般不改） | `workerEntry.ts` |
| `CLAUDE_HTTP_SERVER_HOST` | `0.0.0.0` | 绑定地址；可改 `127.0.0.1` 提升安全 | `workerEntry.ts` |
| `CLAUDE_HTTP_SERVER_TOOLS_ENABLED` | `0` | 允许 `tools=true` 进 agent loop | `routes.ts` |
| `CLAUDE_HTTP_SERVER_CWD` | `process.cwd()` | agent loop 的工作目录 | `routes.ts` |
| `CLAUDE_HTTP_SERVER_WORKER` | (内部) | 由 Bun.spawn 注入，标识当前进程是 daemon 子进程 | `workerEntry.ts`（诊断用） |
| `CLAUDE_HTTP_SERVER_LOG` | `~/.claude/http-server.log` | 日志文件路径 | `workerEntry.ts` |
| `CLAUDE_HTTP_SERVER_READY_TIMEOUT_MS` | `3000` | 父进程等待 daemon ready 的最长时间 | `index.ts` |
| 已有：`ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_MODEL`/`CLAUDE_CODE_USE_BEDROCK`/`CLAUDE_CODE_USE_VERTEX`/`CLAUDE_CODE_USE_FOUNDRY` | —— | 透传到 daemon，决定上游路由 | `client.ts`（已有逻辑） |

## 10. 实施前置验证（第一步必须做）

在动笔写业务代码前，必须先跑这 3 个探测，根据结果微调方案：

### 10.1 `feature('DAEMON')` 在 `bun run dev` 下的求值

**背景**：`src/entrypoints/cli.tsx:100` 使用 `if (feature('DAEMON') && args[0] === '--daemon-worker')` 作为 fast-path 守卫。`feature()` 来自 `bun:bundle`，是 Bun **构建期 DCE 常量替换机制**。项目用 `bun run dev` 直接运行 TS，无 `bunfig.toml`，无显式 build 步骤，行为未知。

**探测方法**：写临时脚本 `scripts/probe-feature.ts`：
```ts
import { feature } from 'bun:bundle'
console.log({ DAEMON: feature('DAEMON'), BRIDGE_MODE: feature('BRIDGE_MODE') })
```
跑 `bun run scripts/probe-feature.ts`。

**分支处理**：
- 若返回 `true` → 按方案 A 原样走，cli.tsx 无需改
- 若返回 `false` → 两个选项（二选一）：
  - A1：在 cli.tsx 的 fast-path 外**新增**一段无 `feature()` gate 的 `if (args[0] === '--daemon-worker')`（仅匹配 `http-server` kind）
  - A2：用 daemon worker 以外的新 fast-path，例如 `--http-server-worker`，完全独立不绑 `feature('DAEMON')`
- 若直接抛 `Cannot find package 'bundle'` → 说明 feature() 在运行时不可用，等同 false，走 A2

**推荐**：探测返回 false 时采用 **A1**（最小侵入，仍复用 `--daemon-worker` 约定）。

### 10.2 detached spawn 在 macOS 下的存活性

**探测方法**：写临时脚本 spawn 一个 long-sleep 子进程（detached+unref），父进程立刻 exit，外部用 `ps -p <pid>` 观察子进程是否存活 3 秒以上。

**分支处理**：
- 若存活 → Bun.spawn 方案 OK
- 若父 exit 子也死 → 改用 `child_process.spawn` with `detached:true, stdio:'ignore'`（Node.js 标准 detach 机制）

### 10.3 `Bun.serve` 在子进程里绑 `0.0.0.0:6646`

**探测方法**：手跑 `bun run src/bootstrap-entry.ts --daemon-worker http-server`（或 probe 脚本），确认：
- 能绑定 0.0.0.0:6646
- 能 `curl localhost:6646/healthz` 拿到 200
- 能再开一个实例验证 EADDRINUSE 处理

**分支处理**：若 `Bun.serve` 抛权限或 IPv6 相关错，把绑定降级到 `127.0.0.1`（并把这一条作为文档 known limitation）。

### 10.4 `src/query.ts` / `src/QueryEngine.ts` 的公开 API 形态

**背景**：§ 4.2 路径 3 的 agent loop 设计假设能 `import { query }` 并获得一个可迭代消息流 + 支持自定义 tool 白名单 + AbortSignal。这是**设计阶段未 Read 的隐式假设**，必须实施前先 Read 确认。

**探测方法**：实施 Task 1 开始前，先 Read：
- `src/query.ts`
- `src/QueryEngine.ts`
- `src/tools.ts`

确认能回答以下问题：
1. 入口函数名和签名（是 `query()` 还是 `runQuery()` 还是 `QueryEngine.run()`）
2. 如何传入工具白名单（是构造 ToolsetContext 还是 Tool 数组）
3. 是否原生支持 AbortSignal
4. 输出是 AsyncIterable<Message> 还是事件回调

**分支处理**：
- 若 API 形态与 spec 一致 → 按原计划实施
- 若 agent loop 的集成成本超预期（例如需要大量模拟 REPL 的 AppState）→ **砍需求**：tools 路径改为 "暴露 Anthropic 原生 tool_use 事件到 SSE，但不执行工具（由客户端回调执行）"。这一降级不影响纯透传路径 (§ 4.2 路径 1/2)，只影响路径 3 的能力边界，可作为本期交付范围。

## 11. 测试策略（manual smoke，不写自动化测试）

项目 `CLAUDE.md` 明确 "No lint, test, or build scripts. Validation is manual smoke-testing"。因此：

### 11.1 Smoke 测试清单

```bash
# 0. 前置：CLAUDE_HTTP_SERVER_ENABLED=1 (默认)
# 1. 启动 CLI，等 REPL 出现
bun run dev
# 新开终端：
cat ~/.claude/http-server.json
TOKEN=$(jq -r .token ~/.claude/http-server.json)

# 2. healthz
curl -sf localhost:6646/healthz
# 期望：{"ok":true,"pid":...,"port":6646,...}

# 3. OpenAI 兼容 SSE
curl -N -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -X POST localhost:6646/v1/chat/completions \
  -d '{"model":"MiniMax-M2.7","messages":[{"role":"user","content":"say hi"}],"stream":true}'
# 期望：多行 data:{...delta...} + data:[DONE]

# 4. Anthropic 原生 SSE
curl -N -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -X POST localhost:6646/v1/messages \
  -d '{"model":"MiniMax-M2.7","messages":[{"role":"user","content":"say hi"}],"stream":true,"max_tokens":128}'
# 期望：event: message_start ... event: content_block_delta ... event: message_stop

# 5. 鉴权失败
curl -i localhost:6646/v1/messages -X POST -d '{}'
# 期望：401

# 6. 幂等启动
bun run dev  # 另开终端再跑一次
# 期望：新 CLI 不再 spawn daemon，日志显示 already-running

# 7. 存活性
# 关闭第一个 CLI (Ctrl-C)，之后 daemon 应仍在跑，curl healthz 仍 200

# 8. tools 护栏
CLAUDE_HTTP_SERVER_TOOLS_ENABLED=0  # (默认)
curl -X POST -H "Authorization: Bearer $TOKEN" \
  localhost:6646/v1/messages -d '{"tools":true,...}'
# 期望：403 tools disabled
```

### 11.2 验证"不偷懒"（用户明确要求）

遵照用户 CLAUDE.md："不要假装使用简单的测试方法或mock方法导致验证通过，要真实验证"。所以：

- 必须用真实的 `ANTHROPIC_BASE_URL` / API key 打到真实上游（MiniMax 或 Anthropic）
- 不做 mock stream、不做 fake response
- Smoke 步骤 3/4 必须观察到上游返回的真实 delta

## 12. 风险 & trade-off

| 风险 | 缓解 |
|---|---|
| feature('DAEMON') DCE 导致 fast-path 不生效 | § 10.1 前置探测 + 备选 A1/A2 方案 |
| detached 进程遗留："孤儿 daemon"，用户不知 6646 被占 | lockfile 含 pid+startedAt；可加 `claude http-server stop` CLI 子命令作后续迭代（非本期） |
| 0.0.0.0 绑定泄露 token | 用户随时可以 `CLAUDE_HTTP_SERVER_HOST=127.0.0.1` 降级；文档说明 trade-off |
| 上游切换需要重启 daemon（env 快照） | 在文档里说明；加一个 `/shutdown` 端点方便运维 |
| 与项目 `src/services/daemon/daemon.ts`（既有定时器 daemon）命名碰撞 | 本功能放 `src/services/httpServer/`，worker 注册放 `src/daemon/workerRegistry.ts`，和 `src/services/daemon/` 物理解耦 |
| CLI fast-path 被意外阻塞 | `ensureHttpServerRunning()` 必须 **fire-and-forget**；任何错误都只 logForDebugging，不抛、不 await 超 3s |
| agent loop 安全 | § 8.2 三重护栏：默认关 + loopback 硬检查 + 工具白名单 |

## 13. 未来迭代（非本期）

- `/v1/embeddings` 端点（若上游支持）
- `claude http-server {status,stop,logs}` CLI 子命令
- WebSocket 端点（双向对话）
- 多实例（端口自动递增）
- Prometheus metrics 端点
- 请求速率限制
