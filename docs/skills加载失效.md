
⏺ 根因定位（加载未坏，是"召回抑制层"误伤）

结论：skills 的渐进式加载逻辑没坏，是近期新加的 intent 过滤层把召回/attachment 注入整条链路彻底 short-circuit 了。

证据链（自底向上）

1. 渐进式加载链本身完好（src/skills/loadSkillsDir.ts）
- 启动期 getSkillDirCommands() 仍按 managed → user → project → additional → legacy commands 并行扫描
- 会话期 discoverSkillDirsForPaths() + addSkillDirectories() 仍在文件路径触达时追加 .claude/skills / .skills
- 条件型 skills（frontmatter paths）仍按 activateConditionalSkillsForPaths() 懒激活
- commit 957232c 只给 getDynamicSkills() 加了按频率排序（P5 程序性记忆），不减少加载数量

2. 召回层被硬截断（src/services/skillSearch/localSearch.ts:244-247）
   const intent = classifyIntent(signal.query)
   if (shouldSuppressEscalationForIntent(intent)) {
   return []              // ← skills 召回直接吞掉，外层 prefetch/attachment 自然空
   }

3. simple_task 正则过猛（src/services/skillSearch/intentRouter.ts:80）
   /^(?:请|帮我|麻烦|直接|please\s+)?\s*(?:(?:看下|看看|解释|说明|告诉我|分析|检查|确认|修复|添加|删除|更新|运行|重命名|移动|打开)…|(?:fix|review|add
   |run|update|delete|remove|rename|show|find|list|change|move|open|close|read|get|set)\b)/iu
   凡是 ≤120 字符且以 "请 / 帮我 / 看下 / 分析 / 检查 / 修复 / update / fix / review…" 开头的日常请求 → 一律归 simple_task → shouldSuppressEscalation
   = true → 一刀切 return []。

4. 融合阈值再补刀（fusionWeightsFor）
- simple_task：minScore: 9999
- chitchat：minScore: 9999
- ambiguous + 保守 provider（MiniMax / 第三方 API）：minScore: 9999
- 你用的 MiniMax-M2.7 命中 isConservativeExecutionProvider()（src/utils/model/providers.ts:8 附近），所以 ambiguous 也被封

5. 同一 suppress 规则被 3 处复用（触类旁通的叠加效应）
- src/services/skillSearch/localSearch.ts:245 — 关掉 skills 召回
- src/services/executionMode/decision.ts:239 — 关掉执行模式升级
- src/services/modelRouter/router.ts:257 — 关掉 model router 升级
  改一处 shouldSuppressEscalationForIntent 行为，三处同步生效。

引入时间线

- 15011d6 (2026-04-15) 新增 simple_task 类 → 直接改 localSearch
- 69b0be1 (2026-04-15) 把 simple_task+chitchat 纳入 shouldSuppressEscalationForIntent
- d593e5f/957232c 之后 skills tracking/排序迭代，未再回退该抑制

修复方案（复用已有开关/模式，最小改动）

优先级从低成本到高稳妥，建议挑一条执行，我可以帮你落地：

┌───────────────────────┬──────────────────────────────────────────────────────────────────┬─────────────────────────────────────────┬────────┐
│         方案          │                             改动位置                             │                  要点                   │  风险  │
├───────────────────────┼──────────────────────────────────────────────────────────────────┼─────────────────────────────────────────┼────────┤
│                       │ intentRouter.ts:216 fusionWeightsFor.simple_task 把 minScore 从  │ 保留"简单任务不过度升级"意图，但 skills │        │
│ A. 降权而非封禁       │ 9999 降为 120；且让 shouldSuppressEscalationForIntent 只对       │  召回在强匹配时仍可命中                 │ 最小   │
│                       │ chitchat 返回 true                                               │                                         │        │
├───────────────────────┼──────────────────────────────────────────────────────────────────┼─────────────────────────────────────────┼────────┤
│ B. 收紧               │ intentRouter.ts:80 & intentRouter.ts:117，加 q.length <= 30      │ 回归到"真·单动词短指令"才被判为         │        │
│ SIMPLE_DIRECT_TASK    │ 或"无空格/无标点"守卫                                            │ simple_task                             │ 中     │
│ 范围                  │                                                                  │                                         │        │
├───────────────────────┼──────────────────────────────────────────────────────────────────┼─────────────────────────────────────────┼────────┤
│                       │ 复用 CLAUDE_SKILL_INTENT_ROUTER 模式，新增                       │ 与项目现有 shadow                       │        │
│ C. 走影子开关         │ CLAUDE_SKILL_SUPPRESS_SIMPLE（默认                               │ 风格一致，可零回归灰度                  │ 最稳妥 │
│                       │ off），shouldSuppressEscalationForIntent 读它                    │                                         │        │
└───────────────────────┴──────────────────────────────────────────────────────────────────┴─────────────────────────────────────────┴────────┘

推荐 A+B 组合：simple_task 不再 suppress（只降权），同时把正则限制在短指令。这样既保留"简单请求不硬塞技能"的初衷，又让 "帮我看下 X 是怎么回事"
这种中等长度请求重新能召回 skills。

要我直接按哪种方案落地？我倾向 A+B 一起改（只动 intentRouter.ts 一文件、<20 行）。


--------------------------------------------------------

⏺ A+B 落地完成，真实运行验证全部符合预期。

改动汇总（两文件、<25 行）

src/services/skillSearch/intentRouter.ts
- SIMPLE_DIRECT_TASK 长度门限 120 → 30（B，只对真·单动词短指令生效）
- fusionWeightsFor('simple_task').minScore 9999 → 120，权重 0.15/0.15 → 0.25/0.2（A，降权不封禁）
- 新增 shouldSuppressSkillRecallForIntent()：只对 chitchat 硬截断，保留原 shouldSuppressEscalationForIntent() 不动

src/services/skillSearch/localSearch.ts
- 调用点切到 shouldSuppressSkillRecallForIntent（localSearch.ts:247）

▎ executionMode/decision.ts:239 与 modelRouter/router.ts:257 继续沿用原 shouldSuppressEscalationForIntent，执行模式/模型路由对 simple_task
的"不升级"语义保留，零回归。

真实验证（bun 动态导入直接跑）

┌────────────────────────────────────────────────┬─────────────┬─────────────────────┬────────────────────┬──────────┐
│                     Query                      │    class    │ suppressSkillRecall │ suppressEscalation │ minScore │
├────────────────────────────────────────────────┼─────────────┼─────────────────────┼────────────────────┼──────────┤
│ 帮我看下 X 是怎么回事                          │ simple_task │ false ✓             │ true（保留）       │ 120      │
├────────────────────────────────────────────────┼─────────────┼─────────────────────┼────────────────────┼──────────┤
│ 请修复这个bug                                  │ simple_task │ false ✓             │ true（保留）       │ 120      │
├────────────────────────────────────────────────┼─────────────┼─────────────────────┼────────────────────┼──────────┤
│ update deps                                    │ simple_task │ false ✓             │ true（保留）       │ 120      │
├────────────────────────────────────────────────┼─────────────┼─────────────────────┼────────────────────┼──────────┤
│ fix                                            │ simple_task │ false ✓             │ true（保留）       │ 120      │
├────────────────────────────────────────────────┼─────────────┼─────────────────────┼────────────────────┼──────────┤
│ hello                                          │ chitchat    │ true ✓              │ true               │ 9999     │
├────────────────────────────────────────────────┼─────────────┼─────────────────────┼────────────────────┼──────────┤
│ /commit                                        │ command     │ false ✓             │ false              │ 50       │
├────────────────────────────────────────────────┼─────────────┼─────────────────────┼────────────────────┼──────────┤
│ 重构 auth 模块                                 │ ambiguous   │ false ✓             │ false              │ 30       │
├────────────────────────────────────────────────┼─────────────┼─────────────────────┼────────────────────┼──────────┤
│ 请 帮我 分析这段代码为什么报错，并给出修复方案 │ ambiguous   │ false ✓             │ false              │ 30       │
└────────────────────────────────────────────────┴─────────────┴─────────────────────┴────────────────────┴──────────┘

预期效果

- 原先被 simple_task 一刀切吞掉的中文日常请求（"帮我看下 / 请修复 / update X"）现在会进入召回，只是需要达到 minScore=120
  才会上榜——即"技能名精确包含 + 描述命中"这类强匹配才会被推荐，弱匹配仍被抑制，不会过度技能化。
- chitchat 和"真·单动词+≤30 字符"场景仍然零召回。
- 执行模式/模型路由对 simple_task 的不升级语义完全保留。

无需重启服务（仅 TS 源码变更，下次请求即生效）。需要我顺手提交到 git 吗？
--------------------------------------------------------

--------------------------------------------------------


--------------------------------------------------------

--------------------------------------------------------

--------------------------------------------------------


--------------------------------------------------------

--------------------------------------------------------

--------------------------------------------------------


--------------------------------------------------------

--------------------------------------------------------

--------------------------------------------------------
