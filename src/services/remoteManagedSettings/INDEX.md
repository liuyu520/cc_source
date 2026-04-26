# `src/services/remoteManagedSettings/` 模块索引

## 模块定位

`src/services/remoteManagedSettings/` 负责企业远程托管设置的拉取、校验、缓存与同步，是 remote-managed settings 的后端实现。

## 关键文件

- `index.ts`
  主服务入口，包含 eligibility、加载 promise、checksum、拉取重试
- `syncCache.ts`
  eligibility 与缓存协助
- `syncCacheState.ts`
  session/cache 状态
- `types.ts`
  响应类型

## 安全校验

- `securityCheck.tsx`
- `securityCheck.jsx`

负责托管设置的安全检查与结果处理。

## 设计关注点

- 同时支持 API key 与 OAuth 认证头
- 加载 promise 带超时，避免其他系统等待远程设置时死锁

## 关联模块

- 设置系统： [../../utils/settings/INDEX.md](../../utils/settings/INDEX.md)
- 状态层： [../../state/INDEX.md](../../state/INDEX.md)
