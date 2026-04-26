# LLM 分类器 Prompt 纪律

## 适用场景

给 LLM 一段短文本,让它吐一个 boolean / 枚举 / 置信度的**分类结果**。典型任务:

- 意图分类("是否自动续聊" / "是否需要搜索")
- 情感 / 态度识别("用户是不是不满意")
- 路由决策("这条消息应该走哪条处理链")
- 安全过滤("这段代码有没有敏感内容")

**不适用**:需要自由文本的任务(总结、改写、推理链)。那些任务用 [llm-prompt-evidence-grounding.md](llm-prompt-evidence-grounding.md) 的"原始证据注入"模式。

## 核心骨架:五段式 system prompt

分类器 prompt **必须**按以下结构组织:

```
【任务声明】  这是什么任务,输入是什么,在什么语境下判定
【核心原则】  最容易踩坑的一条规则,写在最前面让 LLM 强 prime
【正向信号】  ≥N 类标签 A 的合法信号(每类一两个具体例子)
【反向信号】  ≥M 类标签 B 的合法信号(同样带例子)
【优先级规则】 正反信号冲突时谁赢,用显式条目列清
【硬性约束】  输出格式(JSON)+ 字段含义 + 置信度语义 + 禁用围栏
```

最后附 3-5 个 **few-shot JSON 范例**(覆盖每类信号),让 LLM 对齐输出格式。

### 为什么核心原则要前置?

LLM 读 system prompt 时前几句权重最高。对于"**容易被表面特征误导**"的分类任务,把反直觉的规则写在最前面,可以压过后面细则的噪声。

现实案例(auto-continue LLM 的血泪教训):

- **初版**:正反信号按序列出,LLM 看到末尾有问号一律判 `wait`,5/10 错判
- **终版**:首段加"**末尾出现问号 ≠ 一定要 wait。问号只是'礼貌征询'的语法形式**",10/10 正确

所以新分类器落地的顺序应是:
1. 先列一遍正反信号 → 跑样本集
2. 看哪些 case 被错判 → 抽出一条核心反直觉规则
3. 把这条规则置顶到【核心原则】 → 再跑一次验证

## 骨架代码

### System Prompt 模板

```ts
const SYS_PROMPT = `你是"XXX 分类器"。输入是 <场景描述>。在 <前置条件> 的语境下,判断应打哪个标签。

【核心原则 —— 必须先读懂这一条】
<把最反直觉的一条规则写在这里,让 LLM 先内化。示例:"末尾问号 ≠ 一定 wait">

【标签 A 的合法信号】
① <信号类型>: <判定要点>。
  例: "<具体文本片段>" → A(解释为什么)
② ...
③ ...

【标签 B 的合法信号】
a. <信号类型>: <判定要点>。
  例: "<具体文本片段>" → B
b. ...
c. ...

【优先级规则】
- 若 <X 信号> 与 <Y 信号> 并存,<X> 赢 → 判 <标签>
- 若 <Z 信号> 与 <W 信号> 并存,<Z> 赢 → 判 <标签>

【硬性约束】
- 只输出一行严格 JSON,禁止 markdown 围栏、禁止解释、禁止多余空白
- 字段: decision(A|B) / confidence(0~1 两位小数) / reason(≤40 字,命中哪类信号或哪个否决词)
- 置信度 <0.7 的 decision 会被调用方降级,宁可 wait 也别乱标

示例输出:
{"decision":"A","confidence":0.9,"reason":"①<正向信号简述>"}
{"decision":"A","confidence":0.85,"reason":"③<正向信号简述>"}
{"decision":"B","confidence":0.88,"reason":"a <反向信号简述>"}
{"decision":"B","confidence":0.82,"reason":"b <反向信号简述>"}`
```

### User Message 模板

```ts
const userMsg = `<input>\n${tail(text)}\n</input>\n\n请输出判定 JSON:`
```

- 用 XML 标签(`<input>…</input>`)包裹原始文本,让 LLM 清楚边界,不会把文本里的中文指示当成新指令。
- 尾部写明"请输出判定 JSON",给 LLM 最后一推。
- 文本不要预处理 / 不要做统计摘要 —— 给**原始尾部**。见 [llm-prompt-evidence-grounding.md](llm-prompt-evidence-grounding.md)。

### 响应解析(严格 JSON 提取)

```ts
function parseDecisionJSON(raw: string): Outcome | null {
  if (!raw) return null
  const trimmed = raw.trim()
  const candidates = [trimmed]
  // LLM 偶尔会多带空白或微量前后缀,兜底用正则抓第一个 {...}
  const match = trimmed.match(/\{[\s\S]*\}/)
  if (match && match[0] !== trimmed) candidates.push(match[0])

  for (const c of candidates) {
    try {
      const obj = JSON.parse(c) as Record<string, unknown>
      const decision = obj.decision
      const confidence = obj.confidence
      const reason = obj.reason
      if (decision !== 'A' && decision !== 'B') continue
      const conf = typeof confidence === 'number' ? Math.max(0, Math.min(1, confidence)) : 0.5
      return {
        decision,
        confidence: conf,
        reason: typeof reason === 'string' ? reason.slice(0, 80) : '',
      }
    } catch { continue }
  }
  return null
}
```

## 关键约束

### 1. `temperature: 0`

分类任务要**确定性**,不要靠 sampling 多样性。每次同输入应输出同结果,便于 A/B test 和回归。

### 2. 输出 JSON 而非自由文本

- `decision`:枚举,**不接受自由文本**(防止"It seems like we should continue" 这种),解析失败直接 null
- `confidence`:0-1,两位小数
- `reason`:≤40 字的命中依据,审计/debug 用

禁止 markdown 围栏(```json```):每次解析都要剥围栏很烦,直接约束 LLM 吐单行 JSON。

### 3. 置信度阈值降级

```ts
const MIN_CONFIDENCE_FOR_POSITIVE = 0.7

if (decision === 'A' && confidence < MIN_CONFIDENCE_FOR_POSITIVE) {
  // 视为未识别,degrade 到 null/wait
  return null
}
```

核心直觉:**错过一次 A 的代价 << 错误 A 一次的代价**(本项目里错误续聊 = 无用 API 调用 + 可能跑错方向;漏续聊 = 用户多按一次回车)。阈值写 0.7 不是理论值,是 few-shot 调出来的经验值。

### 4. 语义与静态规则对齐

如果分类器上游还有正则/表查的 sync 路径,system prompt **必须把 sync 规则也复述一遍**。见 [regex-then-llm-fallback-classifier.md](regex-then-llm-fallback-classifier.md) 的"两条路径语义同源"约束。

反例:正则判定 "末尾有'?'且无第一人称表态 → wait",但 LLM prompt 只讲"第一人称表态 → continue" 没提问号规则 → LLM 放行"?你觉得呢?",与正则分歧。

### 5. Few-shot 输出必须覆盖边界

示例输出要覆盖:
- **每一类**正向信号至少一个(让 LLM 知道 `reason` 字段怎么写)
- **每一类**反向信号至少一个
- **冲突情境**一个(展示优先级规则的应用)
- **低置信**一个(展示阈值降级的 `confidence<0.7`)

**不要**只写 1-2 个示例 —— LLM 会模仿示例里单调的 `reason` 结构,覆盖面不够。

## 验证流水线

新分类器上线前的最小验证集合:

```ts
// tmp-verify-llm.ts —— 手工跑,不入 git
const cases: [string, 'A' | 'B'][] = [
  // 10 条正向(至少覆盖每一类合法信号 2 个)
  ['...第一人称表态', 'A'],
  ['...价值断言',     'A'],
  ['...锁定对象',     'A'],
  ['...零成本延续',   'A'],
  ['...工单阶段推进', 'A'],
  // 10 条反向(至少覆盖每一类反向信号 2 个)
  ['...纯开放请示',   'B'],
  ['...不确定/风险',  'B'],
  ['...多选择列举',   'B'],
  // 5-8 条边界
  ['问号+表态',       'A'],
  ['表态+不确定',     'B'],
]

for (const [text, expect] of cases) {
  const got = await classifyViaLLM(text)
  console.log(got?.decision === expect ? 'PASS' : 'FAIL', text.slice(0, 40), got)
}
```

**跑到 10/10 通过才合入**。中间若 5/10 失败:

1. 检查是不是被表面特征误导(问号、感叹号、特定句式)
2. 找到共性,抽一条"核心原则"加到 prompt 首段
3. 再跑一次
4. 仍失败就调 few-shot 示例(加对应的 case)

**不要做模拟数据跑过了就提交** —— 真实调用 LLM 才能看出 prompt 的实际效果。见 CLAUDE.md 全局规则"不要假装使用简单的测试方法或 mock 方法导致验证通过"。

## 反模式

| 反模式 | 症状 | 改法 |
|---|---|---|
| 核心原则写在末尾 | LLM 读到末尾已忽略,回到表面特征判定 | 置顶【核心原则】段 |
| 正反信号各说各的,无优先级 | 冲突 case 随机判 | 加【优先级规则】显式排序 |
| 用自由文本而非 JSON | 解析失败率高,降级率高 | 强制 `{decision, confidence, reason}` |
| `temperature > 0` | 同一输入判定不稳定 | 分类器一律 `temperature: 0` |
| 没有置信度阈值 | 低置信也触发,错误率高 | 硬阈值 0.7,低于 degrade |
| few-shot 示例太单调 | LLM 生硬套格式,`reason` 千篇一律 | 每类信号至少一个示例 |
| 没有真实验证集 | 上线后才发现几类系统性错判 | 落代码前跑 10-20 case 真实集 |
| 用 mock 数据验证 | "通过了"但实际 LLM 完全两样 | 真实调网关,不允许 mock |

## 与相关 skill 的关系

- **[regex-then-llm-fallback-classifier.md](regex-then-llm-fallback-classifier.md)**:本 skill 是它路径 B 的 prompt 实现规范。
- **[dedicated-side-llm-client.md](dedicated-side-llm-client.md)**:本 skill 的 prompt 跑在副路 client 上。
- **[llm-prompt-evidence-grounding.md](llm-prompt-evidence-grounding.md)**:本 skill 强调的"给原始文本不做摘要"与之同源;本 skill 偏分类输出约束,那篇偏输入证据约束。
- **[conservative-opt-in-feature-flag.md](conservative-opt-in-feature-flag.md)**:分类器整体走 opt-in + 异常静默。

## 当前项目里的实例

| 文件 | 作用 |
|---|---|
| `src/utils/autoContinueTurnLLM.ts` 中 `LLM_SYSTEM_PROMPT` | 五段式结构完整体现,含 5 类正向信号 + 3 类反向信号 + 优先级 + 硬约束 + 5 个 few-shot |
| `src/utils/autoContinueTurnLLM.ts` 中 `parseDecisionJSON` | 严格 JSON 解析 + 兜底 `/\{[\s\S]*\}/` 抓取 |

## 推广场景候选

按本 skill 的结构,可以快速起新分类器:

| 场景 | 输入 | 输出决策 | 备注 |
|---|---|---|---|
| 是否需要查资料 | 用户上一条消息 | `need_search` / `no_search` | 路径 B 兜底"这个词我不认识"之类 |
| 是否要做思考展开 | 用户问题 | `think_first` / `answer_direct` | 用小模型替 main-loop-model 做 meta 判断 |
| AskUserQuestion 默认项 | 问题 + 选项 | 选哪项 | 代替 hardcoded "第一项" |
| 工具摘要决策 | 工具输出末尾 1000 字 | `keep_raw` / `summarize` | 超长输出降本 |

落新分类器时照本 skill 套:
1. 枚举 `decision` 值
2. 写五段 system prompt(核心原则 → 正向 → 反向 → 优先级 → JSON 约束)
3. 写 5 个 few-shot
4. 配套 10-20 case 真实验证集
5. 跑到 100% 才合入
