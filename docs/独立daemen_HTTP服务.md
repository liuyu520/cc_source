
下面是 3 种 detach + 互斥实现方式。4 个核心决策（OpenAI+Anthropic 双协议 / 独立后台进程 / 混合功能深度 / 0.0.0.0+token）在所有方案里不变。

方案 A：复用已有 --daemon-worker 机制（★ 推荐）

已有 src/services/daemon/ 和 cli.tsx 第 100 行的 --daemon-worker=<kind> 快通道（supervisor spawns pattern）。只需：

1. 新增 worker kind：http-server，在 workerRegistry 注册
2. 新建 src/services/httpServer/index.ts（Bun.serve）+ start.ts（detached spawn 自己 claude --daemon-worker=http-server）
3. CLI 启动时（main.tsx init 路径中）调用 ensureHttpServerRunning()：检查 lockfile + 端口健康 → 已跑跳过 / 未跑 detach spawn

优点：完全贴合项目现有"supervisor spawns 子进程"模式（feature('DAEMON') gate、workerRegistry 注册、main.tsx 里的 init
钩子都已备好插槽）；跑起来就是另一个 bun 子进程，无侵入。
缺点：必须绑定到 feature('DAEMON') feature flag 的语义（或另开一个 feature('HTTP_SERVER')）。

方案 B：独立 detach 子进程（脱离 daemon 体系）

在 src/services/httpServer/ 里完全独立地：CLI init → Bun.spawn([bunExe, bootstrap, '--http-server-worker'], {detached:true,
stdio:'ignore'}).unref()，子进程只跑 Bun.serve。

优点：不侵入 daemon 模块；独立的 feature flag / 环境变量 CLAUDE_HTTP_SERVER；好理解。
缺点：和方案 A 90% 代码重合，却另起炉灶，偏离了 cli.tsx 已经建好的 --daemon-worker 快通道约定。

方案 C：进程内启动（不 detach）

在当前 CLI 进程里 Bun.serve，用 proper-lockfile 做跨进程互斥；CLI 退出服务也退出。

优点：最少代码。
缺点：你已经选定"独立 detach 后台进程"，这个方案就不符合既定需求。列出仅作对照。

  ---
我的推荐：方案 A

理由：src/entrypoints/cli.tsx:100-106 里的 --daemon-worker 快通道已经是为这类用途准备的（"perf-sensitive spawned per-worker, no enableConfigs /
no analytics sinks"）。src/services/daemon/ 也已经有 "autonomous nervous system" 语义描述。把 HTTP 服务作为一个新 worker
接进去，就是"举一反三、复用已有逻辑"的最佳贴合。

  ---
互斥 & 健康探测（任一方案共用）

单例检测分两步，保证鲁棒：

1. 读 ~/.claude/http-server.json：若 pid 还在运行 + GET http://127.0.0.1:6646/healthz 200 OK，判"已运行"，CLI 跳过启动。
2. 端口兜底：即使 lockfile 缺失或 stale，Bun.serve 失败（EADDRINUSE）时也会兜底判断"端口已被占用"，静默放弃绑定（可能是用户手动跑了服务）。

Lockfile 采用"写入 + 启动时 stale 检测"策略（不用 proper-lockfile 的文件锁，因为 detach 进程不适合持锁）。

  ---
请确认：采用方案 A 吗？确认后我立刻进入完整设计分节呈现（架构/组件/数据流/错误处理/安全/文件清单），然后写 spec 文档。

✻ Churned for 3m 47s

❯ 采用方案 A

⏺ 完整设计（分节呈现，每节后请确认）

  ---
§ 1 架构总览 & 进程拓扑

┌─────────────────────────────────────────────────────────────┐
│ 用户进入 claude-code CLI                                    │
│  ├─ bootstrap-entry.ts → entrypoints/cli.tsx → main.tsx    │
│  └─ main.tsx init 钩子 → ensureHttpServerRunning()          │
│                             │                                │
│                             ▼                                │
│              ┌──────────────────────────┐                   │
│              │ 1. 读 ~/.claude/http-    │                   │
│              │    server.json + probe   │                   │
│              │    GET :6646/healthz     │                   │
│              └──────────────────────────┘                   │
│                      │         │                             │
│                 已运行│         │未运行/stale                │
│                 跳过 │         ▼                             │
│                      │   Bun.spawn([bun, bootstrap,         │
│                      │     '--daemon-worker=http-server'], │
│                      │     { detached:true,                  │
│                      │       stdio:'ignore' }).unref()       │
│                      │         │                             │
│                      │         ▼ (子进程)                    │
│                      │   cli.tsx fast-path 100-106:          │
│                      │   runDaemonWorker('http-server')      │
│                      │         │                             │
│                      │         ▼                             │
│                      │   src/services/httpServer/            │
│                      │     workerEntry.ts                    │
│                      │     → Bun.serve(0.0.0.0:6646)        │
│                      │     → 写 http-server.json             │
│                      │     → 循环处理请求                     │
│                      │                                       │
│                      ▼                                       │
│               CLI 继续正常 REPL 流程                         │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ 后台 HTTP daemon (独立 bun 进程，脱离父 CLI)                 │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Bun.serve { hostname:'0.0.0.0', port:6646 }          │   │
│  │                                                       │   │
│  │  GET  /healthz             → { ok, pid, version }    │   │
│  │  GET  /v1/models           → 透传到上游             │   │
│  │  POST /v1/chat/completions → OpenAI 兼容 SSE        │   │
│  │  POST /v1/messages         → Anthropic 原生 SSE     │   │
│  │                                                       │   │
│  │  鉴权：Authorization: Bearer <token> (除 /healthz)   │   │
│  │  tools=true / "x-claude-tools":"1" → agent loop     │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘

§ 2 文件清单（新增 5 + 修改 3）

新增：

┌───────────────────────────────────────────────────┬───────────────────────────────────────────────────────────────────────────────────────┐
│                       文件                        │                                         职责                                          │
├───────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────┤
│ src/services/httpServer/index.ts                  │ 对外 API：ensureHttpServerRunning() / stopHttpServerIfOwner() / getHttpServerStatus() │
├───────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────┤
│ src/services/httpServer/lockfile.ts               │ ~/.claude/http-server.json 读写 + stale 检测（pid 探活 + healthz probe）              │
├───────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────┤
│ src/services/httpServer/workerEntry.ts            │ daemon 子进程入口：启 Bun.serve、写 lockfile、注册退出清理                            │
├───────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────┤
│ src/services/httpServer/routes.ts                 │ Bun.serve fetch handler：路由到 OpenAI / Anthropic / agent 处理器                     │
├───────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────┤
│ src/services/httpServer/adapters/openaiAdapter.ts │ OpenAI ⇔ Anthropic 消息/SSE 互转                                                      │
└───────────────────────────────────────────────────┴───────────────────────────────────────────────────────────────────────────────────────┘

修改：

┌───────────────────────────────────────┬──────────────────────────────────────────────────────────────────────┐
│                 文件                  │                                 改动                                 │
├───────────────────────────────────────┼──────────────────────────────────────────────────────────────────────┤
│ src/services/daemon/workerRegistry.ts │ 注册新 worker kind：'http-server' → 指向 workerEntry.ts              │
├───────────────────────────────────────┼──────────────────────────────────────────────────────────────────────┤
│ src/entrypoints/cli.tsx               │ 已有 --daemon-worker 快通道无需改（100-106 行已支持任意 kind）       │
├───────────────────────────────────────┼──────────────────────────────────────────────────────────────────────┤
│ src/main.tsx                          │ init 路径中，REPL 启动前调一次 ensureHttpServerRunning()（失败静默） │
└───────────────────────────────────────┴──────────────────────────────────────────────────────────────────────┘

需要先验证两件事（写 spec 前我会 Read 确认，不瞎写）：
- workerRegistry.ts 的现有结构（注册方式是 switch 还是 map）
- main.tsx 的 init 钩子合适插入点

  ---
这一节（架构 + 文件清单）看着对吗？有问题告诉我；没问题我继续 § 3（组件接口细节）+ § 4（三种请求数据流）。

✻ Brewed for 36s

❯ 对

⏺ 先验证两个挂载点（承诺过要 Read 确认），再呈现 § 3。

Searched for 4 patterns, listed 1 directory (ctrl+o to expand)

⏺ 重要发现：src/daemon/workerRegistry.js 目前不存在（cli.tsx:103 的 import 是 restoration-time 预留的死引用，由 feature('DAEMON')
gate）。这意味着方案 A 需要我们新建这个文件 —— 正好"填槽"，但要确认 feature('DAEMON') 的求值机制别把我们的代码 DCE 掉。


⏺ 所有 smoke 测试通过：

- /healthz — 公开健康检查 ✅
- 未认证请求返回 401 ✅
- /v1/models — 模型列表 ✅
- /v1/chat/completions 非流式 — OpenAI 兼容格式 ✅
- /v1/chat/completions 流式 SSE — 标准 OpenAI SSE 格式 ✅
- /v1/messages — Anthropic 原生端点 ✅
- 幂等启动检测 — already-running ✅
- /shutdown + lockfile 清理 ✅

⏺ 全部任务完成。总结一下实现的文件：

┌───────────────────────────────────────────────────┬──────────────────────────────────────┐
│                       文件                        │                 用途                 │
├───────────────────────────────────────────────────┼──────────────────────────────────────┤
│ src/daemon/workerRegistry.ts                      │ daemon worker 分发注册表             │
├───────────────────────────────────────────────────┼──────────────────────────────────────┤
│ src/services/httpServer/lockfile.ts               │ PID lockfile + stale 探活            │
├───────────────────────────────────────────────────┼──────────────────────────────────────┤
│ src/services/httpServer/adapters/openaiAdapter.ts │ OpenAI ↔ Anthropic 格式转换          │
├───────────────────────────────────────────────────┼──────────────────────────────────────┤
│ src/services/httpServer/routes.ts                 │ HTTP 路由（Bun.serve fetch handler） │
├───────────────────────────────────────────────────┼──────────────────────────────────────┤
│ src/services/httpServer/workerEntry.ts            │ daemon 进程主入口                    │
├───────────────────────────────────────────────────┼──────────────────────────────────────┤
│ src/services/httpServer/index.ts                  │ ensureHttpServerRunning() 入口 API   │
├───────────────────────────────────────────────────┼──────────────────────────────────────┤
│ src/entrypoints/cli.tsx                           │ --daemon-worker 快速通道             │
├───────────────────────────────────────────────────┼──────────────────────────────────────┤
│ src/main.tsx                                      │ CLI 启动时自动拉起 daemon            │
└───────────────────────────────────────────────────┴──────────────────────────────────────┘

每次启动 Claude Code CLI 时自动在 0.0.0.0:6646 启动 HTTP/SSE daemon，支持 OpenAI 兼容和 Anthropic 原生两种协议，通过 lockfile + healthz
防止重复启动。



====

⏺ 以下是所有接口的 cURL 示例（TOKEN 从 ~/.claude/http-server.json 中读取）：

  ---
0. 获取 Token（前置步骤）

TOKEN=$(python3 -c "import json; print(json.load(open('$HOME/.claude/http-server.json'))['token'])")

  ---
1. 健康检查（无需认证）

curl http://127.0.0.1:6646/healthz

  ---
2. 模型列表

curl -H "Authorization: Bearer $TOKEN" \
http://127.0.0.1:6646/v1/models

  ---
3. OpenAI 兼容 — 非流式

curl -X POST http://127.0.0.1:6646/v1/chat/completions \
-H "Authorization: Bearer $TOKEN" \
-H "Content-Type: application/json" \
-d '{
"model": "claude-opus-4-6",
"messages": [
{"role": "system", "content": "You are a helpful assistant."},
{"role": "user", "content": "用一句话介绍自己"}
],
"max_tokens": 200,
"temperature": 0.7,
"stream": false
}'

  ---
4. OpenAI 兼容 — SSE 流式

curl -N -X POST http://127.0.0.1:6646/v1/chat/completions \
-H "Authorization: Bearer $TOKEN" \
-H "Content-Type: application/json" \
-d '{
"model": "claude-opus-4-6",
"messages": [
{"role": "user", "content": "写一首五言绝句"}
],
"max_tokens": 200,
"stream": true
}'

▎ -N 禁用 curl 缓冲，实时看到 SSE 数据块。

  ---
5. Anthropic 原生 — 非流式

curl -X POST http://127.0.0.1:6646/v1/messages \
-H "Authorization: Bearer $TOKEN" \
-H "Content-Type: application/json" \
-d '{
"model": "claude-opus-4-6",
"max_tokens": 200,
"messages": [
{"role": "user", "content": "Hello, Claude!"}
]
}'

  ---
6. Anthropic 原生 — SSE 流式

curl -N -X POST http://127.0.0.1:6646/v1/messages \
-H "Authorization: Bearer $TOKEN" \
-H "Content-Type: application/json" \
-d '{
"model": "claude-opus-4-6",
"max_tokens": 200,
"stream": true,
"messages": [
{"role": "user", "content": "Hello, Claude!"}
]
}'

  ---
7. 关闭服务

curl -X POST -H "Authorization: Bearer $TOKEN" \
http://127.0.0.1:6646/shutdown

  ---
快速一键测试脚本（复制粘贴即用）：

TOKEN=$(python3 -c "import json; print(json.load(open('$HOME/.claude/http-server.json'))['token'])")

echo "=== healthz ===" && curl -s http://127.0.0.1:6646/healthz | python3 -m json.tool
echo "=== models ===" && curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:6646/v1/models | python3 -m json.tool
echo "=== chat (non-stream) ===" && curl -s -X POST http://127.0.0.1:6646/v1/chat/completions -H "Authorization: Bearer $TOKEN" -H "Content-Type:
application/json" -d '{"model":"claude-opus-4-6","messages":[{"role":"user","content":"Say hi"}],"max_tokens":20}' | python3 -m json.tool
echo "=== messages (non-stream) ===" && curl -s -X POST http://127.0.0.1:6646/v1/messages -H "Authorization: Bearer $TOKEN" -H "Content-Type:
application/json" -d '{"model":"claude-opus-4-6","max_tokens":20,"messages":[{"role":"user","content":"Say hi"}]}' | python3 -m json.tool

