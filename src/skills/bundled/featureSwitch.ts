import { AGENT_TOOL_NAME } from '../../tools/AgentTool/constants.js'
import { registerBundledSkill } from '../bundledSkills.js'

const FEATURE_SWITCH_PROMPT = `# /feature-switch — 特性开关设计与回滚保障

为系统底层替换设计安全的特性开关 (Feature Flag) 机制，确保新旧实现可以随时切换，零停机回滚。

## 适用场景

- 替换 Agent/LLM 引擎
- 数据库迁移 (新旧表并行)
- API 版本切换 (v1 → v2)
- 微服务拆分/合并
- 任何"新旧两条路径需要共存一段时间"的变更

## Phase 1: 识别切换点

使用 ${AGENT_TOOL_NAME} 启动 Explore agent 找到所有需要分叉的代码位置:

\`\`\`
搜索策略:
1. 找到新实现的入口/构建函数
2. 找到所有调用它的地方 (参考 /multi-entry-audit)
3. 标记每个分叉点: 这里需要 if 开关
\`\`\`

## Phase 2: 开关设计

### 2.1 开关粒度

| 粒度 | 适用场景 | 示例 |
|------|---------|------|
| 全局 | 简单替换, 全量切换 | \`ENGINE_V2_ENABLED=true\` |
| 用户级 | 灰度发布 | \`user.features.engine_v2\` |
| 会话级 | A/B 测试 | \`session.engine_version\` |
| 接口级 | 部分接口先上 | \`CHAT_USE_V2=true, PLAN_USE_V2=false\` |

### 2.2 开关位置

\`\`\`python
# ✅ 推荐: 在构建/路由层切换 (影响最小)
async def build_agent(user_id, thread_id, ...):
    if settings.NEW_ENGINE_ENABLED:
        return await build_new_agent(...)
    return await build_old_agent(...)

# ❌ 避免: 在消费层切换 (需要改多处)
async def consume_stream(graph, ...):
    if isinstance(graph, NewAgent):  # 每个消费者都要改!
        ...
\`\`\`

### 2.3 开关传播

\`\`\`python
# 配置中心 (Apollo/Nacos/环境变量) → Settings 对象 → 路由函数
class Settings:
    @property
    def NEW_ENGINE_ENABLED(self) -> bool:
        return self._get_config("NEW_ENGINE_ENABLED", False, bool)
        # 默认 False (安全默认值)
\`\`\`

## Phase 3: 回滚保障

### 3.1 回滚链路验证

\`\`\`
开关 OFF → build_old_agent() → 旧引擎 → 旧消费逻辑
开关 ON  → build_new_agent() → 新引擎 → 适配层 → 相同事件格式
\`\`\`

**验证清单:**
- [ ] 开关 OFF 时, 所有接口走旧路径, 功能完全正常
- [ ] 开关 ON 时, 所有接口走新路径, 功能完全正常
- [ ] 切换开关后无需重启服务 (如使用配置中心)
- [ ] 开关默认值是安全的 (默认 OFF 或默认旧引擎)
- [ ] 开关名称清晰无歧义

### 3.2 异常自动回滚

\`\`\`python
# 在路由层: 新引擎构建失败 → 自动回退到旧引擎
try:
    if settings.NEW_ENGINE_ENABLED:
        return await build_new_agent(...)
except Exception as e:
    logger.error("新引擎构建失败, 回退: %s", e)
    # 注意: 这里只对构建失败回退
    # 运行时错误不应静默回退 (会掩盖问题)

# 在消费层: 新引擎类型不匹配 → 不要静默回退!
if isinstance(graph, NewAgent):
    # 新引擎路径, 错误应该抛出
    adapter = Adapter(...)
    async for event in adapter.adapt_stream(graph, ...):
        yield event
    return  # 必须 return, 不能 fall through 到旧路径
# 旧引擎路径
async for chunk in graph.astream(...):
    ...
\`\`\`

### 3.3 监控与告警

\`\`\`python
# 关键指标对比
- 首 token 延迟 (新 vs 旧)
- 工具调用成功率
- 用户中断率
- 消息持久化成功率
- Token 消耗量
\`\`\`

## Phase 4: 灰度策略

\`\`\`
Day 1: 内部测试 (开发团队, 5%)
Day 3: 小流量 (10%)
Day 7: 扩大 (50%)
Day 14: 全量 (100%)
Day 30: 移除旧代码和开关 (清理)
\`\`\`

## Phase 5: 开关清理

当新引擎稳定运行 N 天后:
1. 删除旧引擎代码路径
2. 删除特性开关
3. 删除适配层中的类型检测 (如果统一为新引擎)
4. 更新文档

## 常见陷阱

1. **默认值设错** — 默认 True 意味着新代码一部署就全量切换, 毫无缓冲
2. **消费层分叉而非构建层** — 导致每个入口都要改, 且容易遗漏
3. **静默回退** — \`except: 回退到旧引擎\` 会掩盖新引擎的真实问题
4. **开关不可动态调整** — 需要重启才能切换 = 回滚需要重部署
5. **忘记清理** — 开关和旧代码永远留着, 成为技术债
6. **开关嵌套** — A 开关里套 B 开关, 组合爆炸, 测试不完整
`

export function registerFeatureSwitchSkill(): void {
  registerBundledSkill({
    name: 'feature-switch',
    description:
      'Design safe feature flags for engine/service replacements with zero-downtime rollback guarantees.',
    aliases: ['feature-flag', 'rollback-design'],
    userInvocable: true,
    async getPromptForCommand(args) {
      let prompt = FEATURE_SWITCH_PROMPT
      if (args) {
        prompt += `\n## Target System\n\n${args}`
      }
      return [{ type: 'text', text: prompt }]
    },
  })
}
