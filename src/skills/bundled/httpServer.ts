import { registerBundledSkill } from '../bundledSkills.js'

const HTTP_SERVER_SKILL_PROMPT = `# /http-server — HTTP/SSE LLM 服务管理

管理 Claude Code 内置的全局 HTTP/SSE 服务（端口 6646），支持 OpenAI 兼容和 Anthropic 原生两种协议。

## 服务概述

每次 Claude Code CLI 启动时会自动在后台拉起一个 HTTP daemon 进程，提供 LLM 对话 API：
- **OpenAI 兼容**: \`/v1/chat/completions\`（流式 + 非流式）
- **Anthropic 原生**: \`/v1/messages\`（流式 + 非流式）
- **模型列表**: \`/v1/models\`
- **健康检查**: \`/healthz\`（无需认证）
- **关闭服务**: \`/shutdown\`

## 快速检查服务状态

\`\`\`bash
# 检查 lockfile 是否存在
cat ~/.claude/http-server.json

# 健康探测
curl -s http://127.0.0.1:6646/healthz | python3 -m json.tool
\`\`\`

## 获取 Bearer Token

Token 在 daemon 启动时随机生成，存储在 \`~/.claude/http-server.json\` 中（权限 0600）。

\`\`\`bash
TOKEN=$(python3 -c "import json; print(json.load(open('$HOME/.claude/http-server.json'))['token'])")
\`\`\`

## 所有端点 cURL 示例

### 1. 健康检查（公开，无需认证）

\`\`\`bash
curl http://127.0.0.1:6646/healthz
\`\`\`

响应示例:
\`\`\`json
{"ok":true,"pid":12345,"port":6646,"host":"0.0.0.0","version":"260414.0.3","uptimeMs":3600000}
\`\`\`

### 2. 模型列表

\`\`\`bash
curl -H "Authorization: Bearer $TOKEN" \\
  http://127.0.0.1:6646/v1/models
\`\`\`

### 3. OpenAI 兼容 — 非流式

\`\`\`bash
curl -X POST http://127.0.0.1:6646/v1/chat/completions \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "Content-Type: application/json" \\
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
\`\`\`

### 4. OpenAI 兼容 — SSE 流式

\`\`\`bash
curl -N -X POST http://127.0.0.1:6646/v1/chat/completions \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "claude-opus-4-6",
    "messages": [
      {"role": "user", "content": "写一首五言绝句"}
    ],
    "max_tokens": 200,
    "stream": true
  }'
\`\`\`

> \`-N\` 禁用 curl 缓冲，实时看到 SSE 数据块。

### 5. Anthropic 原生 — 非流式

\`\`\`bash
curl -X POST http://127.0.0.1:6646/v1/messages \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "claude-opus-4-6",
    "max_tokens": 200,
    "messages": [
      {"role": "user", "content": "Hello, Claude!"}
    ]
  }'
\`\`\`

### 6. Anthropic 原生 — SSE 流式

\`\`\`bash
curl -N -X POST http://127.0.0.1:6646/v1/messages \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "claude-opus-4-6",
    "max_tokens": 200,
    "stream": true,
    "messages": [
      {"role": "user", "content": "Hello, Claude!"}
    ]
  }'
\`\`\`

### 7. 关闭服务

\`\`\`bash
curl -X POST -H "Authorization: Bearer $TOKEN" \\
  http://127.0.0.1:6646/shutdown
\`\`\`

## 环境变量配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| \`CLAUDE_HTTP_SERVER_ENABLED\` | \`1\` | 设为 \`0\` 或 \`false\` 禁用自动启动 |
| \`CLAUDE_HTTP_SERVER_PORT\` | \`6646\` | 监听端口 |
| \`CLAUDE_HTTP_SERVER_HOST\` | \`0.0.0.0\` | 监听地址 |
| \`CLAUDE_HTTP_SERVER_LOG\` | \`~/.claude/http-server.log\` | 日志文件路径 |
| \`CLAUDE_HTTP_SERVER_READY_TIMEOUT_MS\` | \`3000\` | 等待 daemon 就绪的超时毫秒数 |
| \`ANTHROPIC_MODEL\` | (SDK 默认) | 覆盖 /v1/models 返回的模型 ID |

## 架构要点

- **Daemon 进程**: 通过 \`Bun.spawn\` 以 detached 模式启动，独立于 CLI 主进程
- **Lockfile**: \`~/.claude/http-server.json\` 存储 PID/端口/Token，用于单例检测
- **Stale 检测**: PID kill(0) + healthz HTTP 探活，双重判断后自动清理 stale lockfile
- **认证**: 随机 32 字节 hex Token，timingSafeEqual 防时序攻击，lockfile 权限 0600

## 相关文件

| 文件 | 用途 |
|------|------|
| \`src/services/httpServer/index.ts\` | \`ensureHttpServerRunning()\` 入口 |
| \`src/services/httpServer/workerEntry.ts\` | Daemon 进程主函数 |
| \`src/services/httpServer/routes.ts\` | HTTP 路由 + fetch handler |
| \`src/services/httpServer/lockfile.ts\` | Lockfile 读写 + stale 判断 |
| \`src/services/httpServer/adapters/openaiAdapter.ts\` | OpenAI ↔ Anthropic 格式转换 |
| \`src/daemon/workerRegistry.ts\` | Daemon worker 分发 |

## 故障排查

1. **服务未启动**: 检查 \`~/.claude/http-server.log\` 日志，确认端口未被占用
2. **401 Unauthorized**: Token 从 lockfile 中读取，确保使用最新的 Token
3. **502 Upstream Error**: API Key 未配置或上游 API 不可达，检查 \`ANTHROPIC_BASE_URL\` / \`ANTHROPIC_API_KEY\`
4. **Lockfile 残留**: \`rm ~/.claude/http-server.json\` 手动清理，下次启动 CLI 会自动重新拉起
`

export function registerHttpServerSkill(): void {
  registerBundledSkill({
    name: 'http-server',
    description:
      'Manage the built-in HTTP/SSE LLM service (port 6646): status check, cURL examples, environment config, and troubleshooting.',
    aliases: ['httpd', 'llm-server'],
    userInvocable: true,
    async getPromptForCommand(args) {
      let prompt = HTTP_SERVER_SKILL_PROMPT
      if (args) {
        prompt += `\n## 用户指令\n\n${args}`
      }
      return [{ type: 'text', text: prompt }]
    },
  })
}
