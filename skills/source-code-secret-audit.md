# 源码级敏感信息审计(Hardcoded Secret & Internal Endpoint Audit)

## 适用场景

仓库里**源代码本身**(不是运行时写盘的样本)含敏感信息的审计 / 清理 / 处置。与 [secret-scrub-before-persist.md](secret-scrub-before-persist.md) 互补:

| | `secret-scrub-before-persist.md` | 本 skill |
|---|---|---|
| **层** | 运行时 | 静态(源代码 / 文档) |
| **触发** | `write(disk, sample)` 之前 | `git commit` / `git push` 之前;代码审查时 |
| **对象** | 用户命令、工具输出、HTTP body 等动态样本 | `const DEFAULT_API_KEY = 'sk-sp-...'`、`README.md` 里的内网 IP |
| **手段** | `scrubSecrets()` 正则过滤 | grep + 人工审计 + 替换为占位符 + **revoke 原值** |

**核心原则**: 源代码是 git 历史的一部分,一旦进入就永久存在。**替换占位符只能防"下次",必须 revoke 原值**来真正止血。

## 常见静态敏感信息(按本项目踩过的坑排序)

| 类别 | 例子 | 风险 |
|---|---|---|
| **真实 API Key 硬编码** | `const DEFAULT_API_KEY = 'sk-sp-7adc...'` | 仓库公开/泄给第三方即可盗刷额度 |
| **内网 IP / 端口** | `http://43.135.10.10:8002` | 被扫描探测端点、定位到服务拓扑 |
| **内网域名** | `internal.corp.local` | 暴露内部架构 |
| **OAuth 代理后端地址** | `https://api.anthropic.com` 改写后的内部代理 | 暴露代理实现 |
| **测试数据库 / S3 bucket 名** | `s3://acme-staging-dumps/` | 可以直接访问未加 ACL 的存储 |
| **JWT / Session token 示例** | 注释里贴的"我本地调出来的 token" | 同 API Key,被当作真值使用 |
| **CI webhook / Slack 内部频道 ID** | README 里的 `T0123/B0456/...` | 推送消息/钓鱼 |

**误区**:以下看起来敏感但**不一定**敏感,别误杀:

- `api.anthropic.com`、`platform.claude.com` —— 公开端点
- `sk-xxx`、`sk-ant-xxx`、`sk-ant-oat01-xxx` —— 明显占位符
- `localhost:*`、`127.0.0.1:*`、`0.0.0.0:*` —— 本机地址
- 公开 demo key(如 Stripe publishable key `pk_test_...`)—— 设计上就是公开的

## 审计 checklist(提交代码前 / 审查代码时)

```bash
# 1. 硬编码 key 前缀型(OpenAI/Anthropic/DashScope/Stripe/GitHub 等)
grep -rnE 'sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}' \
  --include='*.ts' --include='*.js' --include='*.md' --include='*.json' \
  . | grep -v node_modules | grep -v .worktrees

# 2. 常见 key 变量名 + 真值(不是占位符)
grep -rnE '(api[_-]?key|secret|token|password)\s*[:=]\s*["'\''][^"'\''\$x\-]{16,}' \
  --include='*.ts' --include='*.js' \
  . | grep -v node_modules | grep -v example

# 3. JWT
grep -rnE '\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}' \
  . | grep -v node_modules

# 4. 内网 IP(私有地址段 + 端口)
grep -rnE '\b(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)[0-9]+\.[0-9]+:[0-9]+' \
  . | grep -v node_modules | grep -v .worktrees

# 5. 任意 IPv4:port(人工过滤公网服务 vs 内部)
grep -rnE '\b[0-9]{1,3}(\.[0-9]{1,3}){3}:[0-9]+' \
  --include='*.md' --include='*.ts' --include='*.json' \
  . | grep -vE 'localhost|127\.0\.0\.1|0\.0\.0\.0' | grep -v node_modules
```

**必排除**:`node_modules/`、`.worktrees/`、`dist/`、`build/`、`bin/`(可能打包过的)。这些会误报大量。

## 清理流程(按顺序,缺一不可)

发现硬编码敏感值后,按这个**四步**处理,顺序反了会没用:

### ① 识别它是否真机密
- 问:**任何持有这个值的人能否直接调 API、登录服务、访问资源**?能→真机密,继续。不能→改占位符即可。
- 注意:"团队共享 key"只要有后端效力就是机密 —— **"团队共享"不是免罪符**(见下文事故复盘)。

### ② 源码替换为占位符
- 不要留 `// TODO: fill in` 型空字符串 —— 易被 CI 通过但运行时 401。
- 用**说明性占位符**:
  ```ts
  // ❌ 易被遗忘
  export const DEFAULT_API_KEY = ''

  // ❌ 看起来像真值
  export const DEFAULT_API_KEY = 'sk-sp-xxxxxxxx'

  // ✅ 一眼看出未配置,grep 也能定位
  export const DEFAULT_API_KEY = 'sk-sp-PLEASE-SET-CLAUDE_XXX_API_KEY'
  ```
- 注释必写**原因**和**覆盖路径**:`该值为占位符,必须通过 CLAUDE_XXX_API_KEY env 覆盖`。

### ③ **revoke 原值**(最关键,别省略)
- 到原平台(DashScope / Anthropic / AWS / GitHub ...)**立即 revoke/轮换**。
- 没这一步,前面两步约等于没做 —— git 历史上的值依然可用。

### ④ 评估是否需要改写 git 历史
- 如果仓库**从未推送**过:改写历史(`git filter-repo`)是干净的。
- 如果已 push 且协作者多:改写会改 commit hash,要全团队协调。**优先 revoke,历史次要**。
- 即使改写历史,也要假设"已泄露"处理 —— GitHub 缓存 / 搜索引擎 / fork 都可能仍保留。

### 提交前再过一遍
```bash
# 已 staged 的 diff 里没有真 key
git diff --cached | grep -E 'sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{30,}'
# 空输出 = OK
```

## 本项目真实事故复盘(2026-04-27)

### 事实
- `src/utils/autoContinueTurnLLM.ts:46-47` 硬编码 DashScope key `sk-sp-7adc0360970c48adb2460e58664a5392`
- 注释写着:`// 注: 这是用户配置的团队共享 key,不是机密 —— 保留在源码便于默认即开即用。`
- `README.md`(20+ 处)、`skills/third-party-api-setup.md`(1 处)含内网代理 IP `43.135.170.102:8002`

### 错在哪
1. **"团队共享 = 非机密"是错误等价**。只要 key 能直接调 DashScope API 扣配额,它就是机密。"团队共享"只说明分发范围,不说明敏感性。
2. **注释里的"便于默认即开即用"是诱导**。副路 LLM 本就应该是 **opt-in**(见 [conservative-opt-in-feature-flag.md](conservative-opt-in-feature-flag.md)),开箱即用的需求本身就不该存在 —— 未 opt-in 的用户不应该触发任何副路调用。
3. **内网 IP 长期停留在 README** 是因为它在"可运行示例"里。示例必须用 `proxy.example.com` / `localhost:PORT` 这种占位形式,不能直接贴生产值。

### 修复
- 真 key → `sk-sp-PLEASE-SET-CLAUDE_AUTO_CONTINUE_LLM_API_KEY`
- 内网 IP → `proxy.example.com:8002`
- DashScope 控制台 revoke 原 key(执行人手动操作,代码里无法完成)

## 反模式

| 反模式 | 后果 | 改法 |
|---|---|---|
| 注释"这不是机密,放心硬编码" | 合理化硬编码,事故源头 | 任何能调 API 的值都按机密处理 |
| 占位符写成空串 `''` | 运行时 401,但 CI 不炸 | 占位符含 `PLEASE-SET-XXX` 字样,一眼识别 |
| 替换后不 revoke | git 历史里的值仍然有效 | **先 revoke 后改码** |
| 审计时不排除 `node_modules` | 淹没在第三方代码匹配里 | grep 必加 `--include` / `grep -v node_modules` |
| 只扫 `.ts` / `.js`,漏扫 `.md` / `.json` | README / 文档是最大"示例代码"池,最易泄 | 文档文件必须一起扫 |
| 扫 `bin/` 等打包产物 | 打包可能带 inline 值,让人以为已修复却没 | 审计时扫 `bin/` **补充**是必要的,不是跳过 |
| 内网 IP 用 `1.2.3.4` 占位 | 公共 DNS / ARIN 有真主 | 用保留段 `203.0.113.X` 或 `proxy.example.com` |
| 依赖 git hook 单点拦截 | hook 被绕过(`--no-verify`)就失效 | hook 是辅助,审计是主手段 |

## 配套工具建议

项目里已有或可加:
- **pre-commit hook**:跑上面的 grep 清单,命中则 block(当前项目未加,可后续补)
- **CI secret-scan**:`trufflehog` / `gitleaks` 扫全历史 —— 适合周期任务而非每次 commit
- **`scrubSecrets()` 复用**:即使是源码里的硬编码被意外 echo 到日志,运行时的 [secret-scrub-before-persist.md](secret-scrub-before-persist.md) 也会兜底,但**不要依赖兜底**

## 相关 Skill

- [secret-scrub-before-persist.md](secret-scrub-before-persist.md) —— 运行时写盘脱敏(本 skill 的对偶层)
- [dedicated-side-llm-client.md](dedicated-side-llm-client.md) —— 副路 LLM 客户端,其"默认 key"绝不能是真值
- [conservative-opt-in-feature-flag.md](conservative-opt-in-feature-flag.md) —— 需要 key 的功能必须 opt-in,不给"开箱即用"借口硬编码
- [third-party-api-setup.md](third-party-api-setup.md) —— 文档里的 BASE_URL / API_KEY 示例约定
