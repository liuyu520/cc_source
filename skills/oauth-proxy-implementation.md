# OAuth 代理服务器实现指南

本 skill 提供 OAuth 代理服务器的完整实现方案，用于转发 Claude Code 的认证请求。

## 代理服务器职责

将 Claude Code 的所有 HTTP 请求转发到 Anthropic 官方服务器，支持：
- OAuth 授权流程
- Token 交换和刷新
- 用户信息查询
- Claude API 调用

## 核心端点映射

### 1. OAuth 授权端点

```
客户端请求: GET http://your-proxy/oauth/authorize?code=true&client_id=...
转发到:     GET https://platform.claude.com/oauth/authorize?code=true&client_id=...

客户端请求: GET http://your-proxy/cai/oauth/authorize?code=true&client_id=...
转发到:     GET https://claude.com/cai/oauth/authorize?code=true&client_id=...
```

### 2. Token 端点

```
客户端请求: POST http://your-proxy/v1/oauth/token
转发到:     POST https://platform.claude.com/v1/oauth/token

请求体示例:
{
  "grant_type": "authorization_code",
  "code": "auth_code_here",
  "redirect_uri": "http://localhost:8080/callback",
  "client_id": "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  "code_verifier": "pkce_verifier"
}
```

### 3. 用户信息端点

```
客户端请求: GET http://your-proxy/api/oauth/profile
转发到:     GET https://api.anthropic.com/api/oauth/profile
请求头:     Authorization: Bearer {access_token}

客户端请求: GET http://your-proxy/api/claude_cli_profile?account_uuid=xxx
转发到:     GET https://api.anthropic.com/api/claude_cli_profile?account_uuid=xxx
请求头:     x-api-key: {api_key}
```

### 4. Claude API 端点

```
客户端请求: POST http://your-proxy/v1/messages
转发到:     POST https://api.anthropic.com/v1/messages
请求头:     x-api-key: {api_key} 或 Authorization: Bearer {access_token}
```

## 实现示例（Node.js + Express）

```javascript
const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

// 域名映射
const DOMAIN_MAP = {
  '/oauth/authorize': 'https://platform.claude.com',
  '/cai/oauth/authorize': 'https://claude.com',
  '/v1/oauth/token': 'https://platform.claude.com',
  '/api/': 'https://api.anthropic.com',
  '/v1/messages': 'https://api.anthropic.com',
};

// 通用代理中间件
app.all('*', async (req, res) => {
  try {
    // 确定目标域名
    let targetDomain = 'https://api.anthropic.com';
    for (const [prefix, domain] of Object.entries(DOMAIN_MAP)) {
      if (req.path.startsWith(prefix)) {
        targetDomain = domain;
        break;
      }
    }

    const targetUrl = `${targetDomain}${req.path}${req.url.includes('?') ? '?' + req.url.split('?')[1] : ''}`;

    // 转发请求
    const response = await axios({
      method: req.method,
      url: targetUrl,
      headers: {
        ...req.headers,
        host: new URL(targetDomain).host,
      },
      data: req.body,
      validateStatus: () => true, // 接受所有状态码
    });

    // 返回响应
    res.status(response.status);
    Object.entries(response.headers).forEach(([key, value]) => {
      res.setHeader(key, value);
    });
    res.send(response.data);
  } catch (error) {
    console.error('Proxy error:', error.message);
    res.status(500).json({ error: 'Proxy error', message: error.message });
  }
});

app.listen(8002, () => {
  console.log('OAuth proxy running on http://localhost:8002');
});
```

## 实现示例（Python + Flask）

```python
from flask import Flask, request, Response
import requests

app = Flask(__name__)

DOMAIN_MAP = {
    '/oauth/authorize': 'https://platform.claude.com',
    '/cai/oauth/authorize': 'https://claude.com',
    '/v1/oauth/token': 'https://platform.claude.com',
    '/api/': 'https://api.anthropic.com',
    '/v1/messages': 'https://api.anthropic.com',
}

@app.route('/', defaults={'path': ''}, methods=['GET', 'POST', 'PUT', 'DELETE', 'PATCH'])
@app.route('/<path:path>', methods=['GET', 'POST', 'PUT', 'DELETE', 'PATCH'])
def proxy(path):
    # 确定目标域名
    target_domain = 'https://api.anthropic.com'
    for prefix, domain in DOMAIN_MAP.items():
        if request.path.startswith(prefix):
            target_domain = domain
            break

    # 构建目标 URL
    target_url = f"{target_domain}{request.full_path}"

    # 转发请求
    headers = {k: v for k, v in request.headers if k.lower() != 'host'}

    resp = requests.request(
        method=request.method,
        url=target_url,
        headers=headers,
        data=request.get_data(),
        allow_redirects=False
    )

    # 返回响应
    excluded_headers = ['content-encoding', 'content-length', 'transfer-encoding', 'connection']
    headers = [(k, v) for k, v in resp.raw.headers.items() if k.lower() not in excluded_headers]

    return Response(resp.content, resp.status_code, headers)

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8002)
```

## 实现示例（Nginx）

```nginx
server {
    listen 8002;
    server_name localhost;

    # OAuth 授权端点
    location /oauth/authorize {
        proxy_pass https://platform.claude.com/oauth/authorize;
        proxy_set_header Host platform.claude.com;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    location /cai/oauth/authorize {
        proxy_pass https://claude.com/cai/oauth/authorize;
        proxy_set_header Host claude.com;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    # Token 端点
    location /v1/oauth/token {
        proxy_pass https://platform.claude.com/v1/oauth/token;
        proxy_set_header Host platform.claude.com;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    # API 端点
    location /api/ {
        proxy_pass https://api.anthropic.com/api/;
        proxy_set_header Host api.anthropic.com;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    # Claude API
    location /v1/messages {
        proxy_pass https://api.anthropic.com/v1/messages;
        proxy_set_header Host api.anthropic.com;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

## 关键请求头

代理必须**原样转发**以下请求头（不能修改或丢弃）：

```
Authorization: Bearer {token}          # OAuth token（Claude.ai 订阅用户）
x-api-key: {key}                       # API key（Console/PAYG 用户）
anthropic-version: 2023-06-01          # API 版本
anthropic-beta: oauth-2025-04-20       # OAuth 认证必需！缺少此 header 则 401
User-Agent: ClaudeCode/{version}       # 客户端标识
Content-Type: application/json         # 内容类型
```

**特别注意 `anthropic-beta` header**：
- OAuth 用户的 `/v1/messages` 请求必须携带 `anthropic-beta: oauth-2025-04-20`
- 缺少此 header 会导致 `401 OAuth authentication is currently not supported`
- 此 header 可能包含多个值（逗号分隔），代理必须完整转发

## 不走代理的 URL

以下 URL 是浏览器回调页面，必须直接指向 Anthropic 官方域名：

```
https://platform.claude.com/oauth/code/callback       # 手动授权回调
https://platform.claude.com/oauth/code/success         # 登录成功页面
https://platform.claude.com/buy_credits?...            # 购买额度页面
```

这些 URL 在 Claude Code 客户端中已硬编码为 `platform.claude.com`，代理无需处理。

## 测试代理

```bash
# 1. 启动代理服务器
node proxy.js  # 或 python proxy.py

# 2. 测试 API 端点
curl -X POST http://localhost:8002/v1/messages \
  -H "x-api-key: your-key" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-3-5-sonnet-20241022","max_tokens":1024,"messages":[{"role":"user","content":"hi"}]}'

# 3. 配置 Claude Code
export ANTHROPIC_BASE_URL="http://localhost:8002"
export ANTHROPIC_API_KEY="your-key"
claude
```

## 安全建议

1. **HTTPS**: 生产环境使用 HTTPS
2. **认证**: 添加 API key 验证
3. **速率限制**: 防止滥用
4. **日志**: 记录所有请求（脱敏敏感信息）
5. **CORS**: 配置跨域策略

## 故障排查

### 问题：401 Unauthorized
- 检查 `Authorization` 或 `x-api-key` 请求头是否正确转发
- 验证 token 是否过期

### 问题：404 Not Found
- 检查路径映射是否正确
- 确认目标 URL 拼接无误

### 问题：CORS 错误
- 添加 CORS 响应头：`Access-Control-Allow-Origin: *`

### 问题：超时
- 增加代理超时时间（默认 30s 可能不够）
- 检查网络连接到 Anthropic 服务器

## 完整端点列表

```
POST /v1/oauth/token                           → platform.claude.com
GET  /oauth/authorize                          → platform.claude.com
GET  /cai/oauth/authorize                      → claude.com
GET  /api/oauth/profile                        → api.anthropic.com
GET  /api/claude_cli_profile                   → api.anthropic.com
GET  /api/oauth/claude_cli/roles               → api.anthropic.com
POST /api/oauth/claude_cli/create_api_key      → api.anthropic.com
GET  /api/claude_cli/bootstrap                 → api.anthropic.com
GET  /api/organization/claude_code_first_token_date → api.anthropic.com
POST /v1/messages                              → api.anthropic.com
GET  /v1/messages/{id}                         → api.anthropic.com
```
