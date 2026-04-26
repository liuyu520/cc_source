# UI 自动化测试设计:基于 Claude in Chrome 扩展的 AI-native 测试框架

**日期**:2026-04-18
**状态**:Design(待实现)
**代号**:`claude-ui-test`,斜杠入口 `/ui-test`

## 1. 背景与目标

当前仓库已经存在 **Claude in Chrome** 能力:`/chrome` 命令 + `claude-in-chrome` bundled skill + 17 个通过 MCP 协议暴露的 `BROWSER_TOOLS`(`navigate`/`read_page`/`find`/`form_input`/`computer`/`javascript_tool`/`tabs_*`/`read_console_messages`/`read_network_requests`/`gif_creator` 等),配套 Chrome 扩展负责执行真实浏览器动作。

目前这套能力定位是"让 Claude 用自然语言操纵浏览器",不是测试框架。本设计在**完全不改动现有浏览器通道**的前提下,把它扩展成一套面向任意外部 Web 应用(登录态 / OAuth 站点)的 **AI-native UI 自动化测试**框架。

### 1.1 已锁定的关键决策

| 维度 | 选择 | 含义 |
|---|---|---|
| 测试对象 | 任意 Web 应用(外部站点、带登录态) | 不是 Claude Code 自身;不是内部后台 |
| 用例形式 | 全 AI-native(Markdown + Frontmatter) | 用户写业务场景,不写步骤;Claude 理解后执行 |
| 回放通道 | **仅** Chrome 扩展 + `mcp__claude-in-chrome__*` | 不走 Playwright;登录态直接复用 |
| 执行模式 | 动态 + 轨迹缓存(trace-cache) | 首跑由 LLM 探索,产出"隐形脚本" trace;再跑零 LLM 回放 |
| 断言维度 | DOM/文本 + 网络请求 + Console 日志 + 视觉截图 diff | 4 类全要 |
| 自愈策略 | HealAgent 生成 trace patch 入队,人工 review 后 apply | 不默默改脚本;业务层失败不自愈 |
| 主入口 | 斜杠命令 `/ui-test *` + 项目内 `.claude/ui-tests/` | 不做独立 CLI / MCP server(可后续抽) |

### 1.2 非目标

- 不做 headless / CI 执行路径(首版接受"需用户 Chrome 在前台")
- 不做 Gherkin / 显式 step DSL(与 AI-native 方向冲突)
- 不替换或修改 `shims/ant-claude-for-chrome-mcp`(它是还原 stub,真实 MCP 来自用户已装的 Chrome 扩展)
- 不引入新的数据库;所有状态落文件系统,天然可 git 审计

## 2. 顶层布局

### 2.1 项目内目录(用户 / 机器空间分离)

```
<repo>/
└── .claude/
    └── ui-tests/
        ├── cases/                     用户写的用例(Markdown + Frontmatter)
        │   ├── login.md
        │   ├── checkout.md
        │   └── fixtures/              cookie、storageState、测试数据
        │       └── authed-user.json
        ├── .trace/                    Claude 维护的轨迹缓存(勿手改)
        │   ├── login.trace.json
        │   └── checkout.trace.json
        ├── .heal-queue/               自愈产出的 patch(勿手改),待 review
        │   └── 2026-04-18T10-30-login.patch.json
        ├── reports/                   运行报告(HTML + JUnit XML + 证据包)
        │   └── 2026-04-18T10-30/
        │       ├── index.html
        │       ├── junit.xml
        │       └── evidence/
        └── ui-test.config.yaml        baseURL、超时、视觉 diff 阈值等
```

点前缀目录(`.trace/`、`.heal-queue/`)暗示"机器维护、勿手改"。用户日常只在 `cases/`、`fixtures/`、`reports/`、`ui-test.config.yaml` 打交道。

### 2.2 斜杠命令

| 命令 | 作用 |
|---|---|
| `/ui-test new <name>` | 交互式创建 Markdown 用例骨架 |
| `/ui-test run [glob]` | 跑一条或一批用例;默认:有 trace 走 trace,无 trace 即 LLM 探索 |
| `/ui-test heal list` | 列出 `.heal-queue/` 里待 review 的 patch |
| `/ui-test heal show <id>` | 查看某个 patch 的 rootCause + diff + 证据 |
| `/ui-test heal apply <id>` | 把 patch 应用到 trace,自动 commit |
| `/ui-test heal reject <id>` | 丢弃该 patch |
| `/ui-test explain <runId>` | 让 ExplainAgent 中文解读某次 run 的失败根因 |
| `/ui-test retrace <case>` | 丢弃旧 trace,强制重新探索(用于站点大改版) |

## 3. 系统架构

```
┌─────────────────────────────────────────────────────────────────┐
│                     Claude Code(宿主)                           │
│                                                                   │
│  /ui-test 斜杠命令(src/commands/ui-test/)                       │
│      │                                                            │
│      ▼                                                            │
│  ┌─────────────────────────────────────────────────────┐         │
│  │  CaseLoader          读 Markdown + Frontmatter       │         │
│  │  TraceStore          读/写/diff .trace/*.json        │         │
│  │  FixtureManager      注入 cookie / storageState      │         │
│  │  Orchestrator        决定走 trace 还是走 AI 探索      │         │
│  └─────────────────────────────────────────────────────┘         │
│      │                │                                           │
│      ▼(有 trace)    ▼(无 trace 或强制探索)                     │
│  ┌──────────────┐  ┌──────────────────────────┐                  │
│  │ TraceRunner  │  │ ExploreAgent(Claude 子代理)│                │
│  │ 确定性回放    │  │ 读 Markdown → 操作 → 写 trace │              │
│  │ 不走 LLM     │  │ 产出断言结构              │                  │
│  └──────────────┘  └──────────────────────────┘                  │
│      │                │                                           │
│      ▼ 失败             │                                         │
│  ┌──────────────────────────────┐                                │
│  │ HealAgent(Claude 子代理)    │                                │
│  │ DOM + console + network +     │                              │
│  │ screenshot → 修复失败 step    │                              │
│  │ → 产出 trace patch            │                              │
│  └──────────────────────────────┘                                │
│      │                                                            │
│      ▼                                                            │
│  ┌───────────────────┐   ┌──────────────────┐                    │
│  │ AssertionEngine   │   │ ReportBuilder     │                    │
│  │ 4 类断言裁决       │   │ HTML + JUnit +    │                    │
│  │                    │   │ 证据包            │                    │
│  └───────────────────┘   └──────────────────┘                    │
└─────────────────────────────────────────────────────────────────┘
           │
           ▼ 所有 DOM 操作统一走一条通道
┌─────────────────────────────────────────────────────────────────┐
│        mcp__claude-in-chrome__*(17 个 BROWSER_TOOLS,已有)      │
└─────────────────────────────────────────────────────────────────┘
           │
           ▼
        Chrome Extension(用户真实浏览器,含登录态)
```

### 3.1 三种角色的边界

- **TraceRunner**:纯粹的 step 解释器,读 trace、调 MCP tool、比对断言。**永远不调 LLM**——这是成本与速度的保证。
- **ExploreAgent**:独立 Claude 子代理(通过 Agent 工具分派),读 Markdown `## 场景` 与 `## 期望`,一边操作一边产出 trace。只在首跑或显式 `retrace` 时触发。
- **HealAgent**:独立 Claude 子代理,仅在断言失败或 step 执行失败时触发;拿到失败 step 及其上下文(DOM、console、network、screenshot)后产出 JSON Patch;每次 run 最多派 2 次。
- **AssertionEngine**:两条路径的断言裁决都走它,保证口径一致;4 类断言均为确定性逻辑,不依赖 LLM。

### 3.2 子代理工具白名单

| 子代理 | 允许工具 | 禁用 |
|---|---|---|
| ExploreAgent | 全部 BROWSER_TOOLS、读 Markdown 用例文件 | Write / Edit / Bash |
| HealAgent | 全部 BROWSER_TOOLS、读 trace / console / network | Write(只产出结构化 patch,由主进程落盘) |
| ExplainAgent | 读 `reports/<runId>/*`、`heal.log.json` | 任何浏览器操作、Write |

白名单隔离目的:减少幻觉、确保关键副作用(落盘 / commit)经过主进程这一单一入口。

### 3.3 为什么不再建 MCP server / 独立 CLI

首版价值聚焦在斜杠命令路径。`services/uiTest/` 不依赖 Ink,未来若要抽成 MCP server 或独立 CLI,只需增加新入口层,内核零改。

## 4. 数据结构

### 4.1 Markdown 用例(用户唯一写的产物)

```markdown
---
id: login-happy-path
name: 普通用户用密码登录
tags: [smoke, auth]
url: https://app.example.com/login
fixtures: []
timeout: 60s
viewport: { width: 1440, height: 900 }
retries: 1
---

## 场景

以匿名态打开登录页,输入 `USER_EMAIL`、`USER_PASSWORD` 两个秘密
(从 env 取),点击"登录"。验证成功跳转到 `/dashboard` 且顶部显示用户邮箱。

## 期望

- 登录后 URL 以 `/dashboard` 结尾
- 页面出现用户邮箱文本
- `GET /api/me` 返回 200,body 含 `email` 字段
- Console 无 `error` 级别日志
- 视觉:`#top-nav` 区块与 baseline 差异 < 2%
```

设计取舍:
- `## 场景` 是自然语言,**不**是步骤清单——避免退化成隐式 DSL
- `## 期望` 是 bullet 列表,首跑由 ExploreAgent 翻译成结构化断言、落盘后锁定
- Frontmatter 字段最小化;`id` 是 trace 主键,改 `id` 等价于重录

### 4.2 Trace 文件(机器维护)

```json
{
  "schemaVersion": 1,
  "caseId": "login-happy-path",
  "caseHash": "sha256:<hash of case.md>",
  "recordedAt": "2026-04-18T10:12:05Z",
  "recordedBy": "claude-opus-4-7",
  "steps": [
    { "op": "navigate", "url": "https://app.example.com/login" },
    { "op": "waitFor",  "selector": "input[name=email]", "timeout": 5000 },
    { "op": "type",     "selector": "input[name=email]",    "value": "${env:USER_EMAIL}" },
    { "op": "type",     "selector": "input[name=password]", "value": "${env:USER_PASSWORD}",
                        "secret": true },
    { "op": "click",    "selector": "button[type=submit]", "role": "button", "name": "登录" },
    { "op": "waitForUrl", "pattern": "/dashboard$" }
  ],
  "assertions": [
    { "kind": "url",     "op": "endsWith",  "value": "/dashboard" },
    { "kind": "text",    "selector": "body","op": "contains",
                         "valueFrom": "env:USER_EMAIL" },
    { "kind": "network", "url": "/api/me", "method": "GET",
                         "status": 200, "bodyContains": ["email"] },
    { "kind": "console", "levelAtMost": "warn", "excludePattern": "^\\[analytics\\]" },
    { "kind": "visual",  "selector": "#top-nav",
                         "baseline": "evidence/top-nav.baseline.png", "threshold": 0.02 }
  ]
}
```

关键设计:
- `caseHash` 检测"Markdown 改了但 trace 没重录",自动提示 `/ui-test retrace`
- 每个 step 携带**多重定位线索**(`selector` + `role` + `name`),HealAgent 可反查元素,不是裸 CSS 选择器
- `secret: true` 的值永不进 trace 正文,只存 `${env:...}` 引用 → 从源头避免凭证泄漏进 git

### 4.3 Patch 文件(自愈产物)

```json
{
  "caseId": "login-happy-path",
  "runId": "2026-04-18T10-30",
  "failedStepIndex": 4,
  "rootCause": "Submit button selector changed from button[type=submit] to button[data-test=login-submit]",
  "patch": [
    { "op": "replace", "path": "/steps/4/selector",
      "value": "button[data-test=login-submit]" }
  ],
  "evidenceRefs": ["screenshot-step4.png", "dom-step4.html"],
  "verified": true,
  "verifiedRuns": 2
}
```

- `patch` 用 RFC 6902 JSON Patch,工业标准、可审计
- `verified: true` 表示 HealAgent 按新选择器成功跑通 2 次(`verifiedRuns`),降低"自愈骗过一次就入队"风险
- `/ui-test heal apply <id>` 会把 patch 写入 trace 并自动 commit

## 5. 运行流程

```
start
  │
  ▼
CaseLoader 读 Markdown → 计算 caseHash
  │
  ▼
TraceStore.find(caseId) ?
  ├─ 无 trace ─────────────────┐
  │                              │
  ├─ 有 trace,caseHash 匹配 ──▶ TraceRunner
  │                              │
  └─ 有 trace,caseHash 不符 ──▶ 警告,询问 retrace / 用旧
                                 │
                         ┌───────┴───────┐
                         ▼               ▼
                 TraceRunner         ExploreAgent
                 (零 LLM)            (子代理 + BROWSER_TOOLS)
                         │               │
                         │   产出新 trace + assertions
                         │               │
                         └───────┬───────┘
                                 ▼
                        AssertionEngine 裁决 4 类断言
                                 │
                     ┌───────────┼───────────┐
                     ▼           ▼           ▼
                   全通过       有失败       执行异常
                     │           │           │
                     │     HealAgent        │
                     │    (最多尝试 2 次)  │
                     │           │           │
                     │    成功 → patch 入 .heal-queue/
                     │    失败 → 报告 fail
                     │                       │
                     └───────────┬───────────┘
                                 ▼
                          ReportBuilder
                  HTML + JUnit + 证据包 → reports/<runId>/
```

关键点:
- 断言裁决集中在 AssertionEngine,两条执行路径口径一致
- HealAgent 只在"执行失败或定位失败"时被派遣,**不**处理探索阶段失败(探索阶段由 ExploreAgent 自己处理)
- 每个 case 每次 run 最多派 2 次 HealAgent;超过即判 fail,拒绝无限重试烧 token
- `${env:...}` 秘密在 TraceRunner 内部 resolve,不进日志 / 报告

## 6. 错误处理矩阵

| 失败场景 | 兜底策略 | 可自愈? |
|---|---|---|
| Chrome 扩展未连接 | 直接退出,提示跑 `/chrome` | 否 |
| 目标 URL 打不开/超时 | 记录 `navigation_failed`,不派 HealAgent | 否 |
| Selector 找不到 | 派 HealAgent 用 `role+name+text` 重定位 | 是 |
| 元素可见但点不动(被遮挡) | HealAgent 注入 waitFor + scroll,或改用 `computer` 鼠标 | 是 |
| 网络断言失败(接口 5xx) | **不**自愈(真 bug),直接 fail | 否 |
| Console 出现 error | 按 `excludePattern` 过滤后仍有 → fail;**不**自愈 | 否 |
| 视觉 diff 超阈值 | 产出 diff 图,保留 actual + baseline,标 `visual_regression` | 否(需人决定更新 baseline 还是修 UI) |
| 弹出 JS alert 卡住扩展 | 检测无响应 → 通知用户手动关掉 → 标 `blocked_by_modal` | 否 |
| HealAgent 2 次后仍失败 | 标 `unhealable`,不入 patch 队列;附尝试日志 | 否 |

**核心原则**:HealAgent 只自愈"定位 / 等待"层面的漂移,**不**自愈"业务 / 契约"层面的失败——否则会掩盖真 bug。

## 7. 报告结构

`reports/<runId>/`:
- `index.html` —— 仪表盘:通过率、失败列表、耗时、token 消耗(探索 / 自愈分摊)
- `junit.xml` —— 标准 JUnit,方便未来接 CI
- `<caseId>/`
  - `case.md.snapshot` —— 当次运行时的用例副本(防后续改动导致无法复盘)
  - `trace-used.json` —— 本次采用的 trace(或首跑新生成)
  - `steps.jsonl` —— 每步开始/结束时间、状态、证据文件名
  - `evidence/` —— 每步截图、DOM 快照(可选)、最终 GIF(`gif_creator`)
  - `network.har` —— 汇总自 `read_network_requests`
  - `console.log` —— 汇总自 `read_console_messages`
  - `assertions.json` —— 每个断言的判定、期望、实际
  - `heal.log.json` —— 若派了 HealAgent,其完整尝试链路

### 7.1 `/ui-test explain <runId>`

把 `heal.log.json` + 失败证据丢给 ExplainAgent,产出中文根因结论。这是 AI-native 定位相对其他框架的核心价值——不靠人肉看报告,直接定位到 bug 所在层(UI / 网络 / 业务 / 基础设施)。

## 8. 源码落位

```
src/
├── commands/
│   └── ui-test/                         斜杠命令(模仿 src/commands/chrome/)
│       ├── index.ts                     注册到 src/commands.ts
│       ├── run.tsx                      /ui-test run
│       ├── new.tsx                      /ui-test new
│       ├── heal.tsx                     /ui-test heal list|show|apply|reject
│       ├── explain.tsx                  /ui-test explain
│       └── retrace.tsx                  /ui-test retrace
│
├── services/
│   └── uiTest/                          核心引擎(非 React,可独立单测)
│       ├── CaseLoader.ts
│       ├── TraceStore.ts
│       ├── FixtureManager.ts
│       ├── Orchestrator.ts
│       ├── TraceRunner.ts               零 LLM 的 step 解释器
│       ├── AssertionEngine/
│       │   ├── index.ts
│       │   ├── text.ts
│       │   ├── network.ts
│       │   ├── console.ts
│       │   └── visual.ts                pixelmatch 阈值对比
│       ├── HealQueue.ts                 读写 .heal-queue/ + JSON Patch 应用
│       ├── ReportBuilder/
│       │   ├── html.tsx
│       │   ├── junit.ts
│       │   └── evidence.ts
│       ├── agents/
│       │   ├── exploreAgent.ts          prompt + 工具白名单装配
│       │   ├── healAgent.ts
│       │   └── explainAgent.ts
│       └── browserBridge.ts             唯一接触 mcp__claude-in-chrome__*
│
└── utils/
    └── uiTest/
        ├── caseHash.ts
        ├── selectorFallback.ts          role+name+text 反查
        └── secretResolver.ts            ${env:...} 解析 + 日志脱敏
```

约定:
- `src/commands/ui-test/` 只做 Ink UI + 调 `services/uiTest/`,不放业务逻辑
- `services/uiTest/` 不引用 Ink —— 未来搬去 CLI / MCP server 零改动
- `browserBridge.ts` 是唯一接触 `mcp__claude-in-chrome__*` 的地方 —— 未来替换底层通道只改这一文件

## 9. 实现分期

| 期 | 目标 | 能做什么 | 不做什么 |
|---|---|---|---|
| **P0** 地基 | CaseLoader + TraceStore + browserBridge + `/ui-test new`、`/ui-test run`(仅 explore 路径) | 写一篇 Markdown → Claude 探索执行 → 落 trace + 文本断言 | 不自愈、不做视觉 diff、不做 HTML 报告(console 结果) |
| **P1** 稳定回放 | TraceRunner 零 LLM + caseHash 校验 | 同一 case 第二跑起用 trace、秒出、零探索 token | 仍不自愈 |
| **P2** 断言齐活 | AssertionEngine 的 network / console / visual 三类补齐 | 支持 4 类断言全部 | visual baseline 首次手动确认 |
| **P3** 自愈 | HealAgent + HealQueue + `/ui-test heal` | selector 漂移自动修复、patch review 流程 | 不做业务层自愈(按第 6 节矩阵) |
| **P4** 诊断+报告 | ReportBuilder + ExplainAgent | 失败中文根因解读、HTML 仪表盘 | 未暴露 CLI / MCP |

P0 + P1 即"可用最小闭环",约 2~3 天工作量;P2~P4 按需推进。

## 10. 真实验证路径

按全局规则"最后验证阶段要真实验证、不偷懒",每期验收:

- **P0 验收**:写 `cases/github-search.md`,目标站点 `github.com`(免登录),让 Claude 执行"搜索 claude-code,断言首条结果标题含 'claude'";检查 `.trace/github-search.trace.json` 真实产出、steps 非空
- **P1 验收**:同一 case 再跑一次,REPL 可见 token 消耗明显下降(理想为 0 探索 token)、耗时显著短于 P0 首跑
- **P2 验收**:挑一个真实会输出 console warning 的页面(如 dev 环境带 DeprecationWarning),断言"无 error 级"应过、"无 warn 级"应 fail;网络断言拿真实 API 响应裁决;视觉 diff 用同一页面两次截图应 < 阈值
- **P3 验收**:手动把 trace 里某个 selector 改坏(模拟改版),`run` → 触发 HealAgent → `.heal-queue/` 出现 patch → `/ui-test heal apply` 后再跑通过
- **P4 验收**:把某 `/api/xxx` 主动改成 500,`run` 后 `/ui-test explain` 应产出"失败根因指向后端 500,不是 UI 问题"的结论

**明确拒绝的"假验证"**:
- 不用 mock 的 MCP server 冒充扩展(stub 返回空会让断言永远通过,形同造假)
- 不用本地写死的 HTML fixture(必须真实 Web 站点跑通才算数)

## 11. 对现有代码的影响面

- `src/commands.ts` 加一行 import(命令注册,现有模式)
- `src/constants/prompts.ts` 可能新增子代理 system prompt(仿 `BASE_CHROME_PROMPT` 风格)
- **不动** `src/services/api/claude.ts`、`src/state/`、`src/screens/REPL.tsx` —— 遵守 "PRESERVE EXISTING LOGIC"
- **不碰** `shims/ant-claude-for-chrome-mcp` —— 它是 stub,真实 MCP 来自用户装的 Chrome 扩展

## 12. 风险与开放问题

| 风险 | 缓解 |
|---|---|
| Chrome 扩展 stub 在当前仓库里是 no-op,开发机本地验证需用户装真扩展 | 文档明确告知;P0 验收硬要求接入真扩展 |
| 探索阶段 token 消耗高 | trace 缓存 + 明确单 case 探索预算上限(`ui-test.config.yaml` 可配) |
| 视觉 diff 噪声(抗锯齿、字体渲染) | `threshold` 可配 + 小区域断言优先(不整页)+ baseline 默认由人工首次确认 |
| `caseHash` 太严(注释改动也触发 retrace) | 只对 Frontmatter + `## 场景` + `## 期望` 内容 hash,忽略其他注释段 |
| HealAgent 误判"业务失败"为"定位漂移" | 第 6 节矩阵严格区分:网络 5xx / console error / 视觉回归一律不走 HealAgent |
| 秘密泄漏 | `secret: true` 字段值永不写 trace / 报告;`secretResolver` 对日志做脱敏 |

## 13. 与现有体系的衔接

- **复用** `claude-in-chrome` skill 的 system prompt(`BASE_CHROME_PROMPT`):作为 ExploreAgent / HealAgent 的 prefix,保证浏览器操作风格一致
- **复用** 现有 skill 注册机制(`registerBundledSkill`):若未来要把 `/ui-test run` 的能力提供给主对话以外的上下文,可快速包装成 skill
- **不复用** `/chrome` 命令本身(它是设置面板);`/ui-test` 是独立命令组
