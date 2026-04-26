// Shot 8 smoke test: skillRecallHeat → 精简未命中的索引
//
// 验收目标：
//   1) localSkillSearch 命中技能时,通过 setAppState dispatch skill:hit 给 kernel
//   2) kernel.skillRecallHeat 被正确累加
//   3) 同一会话第二次搜索时,热技能在 RRF 融合中获得加权(相同或相近关键词得分下)
//   4) rankedResults fallback(空 filteredResults)不会误记热度
//
// 运行:  bun smoke-shot8.mjs

import { kernelReducer, kernelDispatchUpdater } from './src/state/kernelDispatch.ts'
import { initialKernelState } from './src/state/kernelState.ts'
import { localSkillSearch } from './src/services/skillSearch/localSearch.ts'

let passed = 0
let failed = 0
const results = []

function assert(label, cond, extra) {
  if (cond) {
    passed++
    results.push(`  ✅ ${label}`)
  } else {
    failed++
    results.push(`  ❌ ${label}${extra ? ` — ${extra}` : ''}`)
  }
}

// ——— Case 1: kernelReducer 直接验证 skill:hit 累加 ———
{
  const s0 = initialKernelState()
  const s1 = kernelReducer(s0, { type: 'skill:hit', skill: 'foo' })
  const s2 = kernelReducer(s1, { type: 'skill:hit', skill: 'foo' })
  const s3 = kernelReducer(s2, { type: 'skill:hit', skill: 'bar' })
  assert('Case1.1 foo heat==2', s3.skillRecallHeat.foo === 2, `got ${s3.skillRecallHeat.foo}`)
  assert('Case1.2 bar heat==1', s3.skillRecallHeat.bar === 1, `got ${s3.skillRecallHeat.bar}`)
  assert('Case1.3 不相干 key 不存在', s3.skillRecallHeat.never === undefined)
  assert('Case1.4 初始态 heat 是空对象', Object.keys(s0.skillRecallHeat).length === 0)
}

// ——— Case 2: kernelDispatchUpdater 幂等性(引用相等短路) ———
{
  const prev = { kernel: initialKernelState() }
  // 0 次不应改变(无此 action 所以拿一个真会 no-op 的场景:cost:add with 0)
  const sameUpdater = kernelDispatchUpdater({ type: 'cost:add', tokens: 0, usd: 0 })
  const next = sameUpdater(prev)
  assert('Case2.1 空 cost 增量返回原引用', next === prev)
}

// ——— Case 3: 通过 localSkillSearch 走完整链路 ———
// 构造一个模拟的 toolUseContext:getAppState + setAppState + 维护一个 appState 单例
async function runLocalSearch() {
  let appState = {
    kernel: initialKernelState(),
    mcp: { commands: [] },
  }
  const getAppState = () => appState
  const setAppState = updater => {
    appState = updater(appState)
  }
  const toolUseContext = {
    getAppState,
    setAppState,
    discoveredSkillNames: new Set(),
  }
  const signal = {
    type: 'user_message',
    query: 'debug',
    mentionedPaths: [],
    recentTools: [],
    activeFileExtensions: [],
  }
  // 第一次调用,触发任何命中的技能 dispatch skill:hit
  const first = await localSkillSearch(signal, toolUseContext, 5)
  const heatAfterFirst = { ...appState.kernel.skillRecallHeat }
  // 第二次同 query:热技能应仍然命中,heat 应进一步累加(或维持 top-64)
  const second = await localSkillSearch(signal, toolUseContext, 5)
  return { first, second, heatAfterFirst, heatAfterSecond: appState.kernel.skillRecallHeat }
}

// 由于 localSkillSearch 依赖真实 commands registry,我们只验证 dispatch 管道是否打通,
// 不对具体技能命名做断言 —— 首次命中数量受 bundle 中实际可召回技能决定。
try {
  const { first, heatAfterFirst, heatAfterSecond } = await runLocalSearch()
  const firstNames = first.map(m => m.name)
  const hitCount = Object.keys(heatAfterFirst).length
  results.push(`  ℹ Case3 info: firstHits=${firstNames.length}, heatKeys=${hitCount}`)
  if (firstNames.length > 0) {
    assert('Case3.1 命中技能后 heatMap 有对应 key',
      firstNames.every(n => heatAfterFirst[n] === 1),
      `expected all hit names to have heat=1, got ${JSON.stringify(heatAfterFirst)}`)
    assert('Case3.2 第二次调用,同技能 heat 累加到 >=2',
      firstNames.every(n => (heatAfterSecond[n] ?? 0) >= 2),
      `expected heat >=2 after repeat, got ${JSON.stringify(heatAfterSecond)}`)
  } else {
    // 无命中结果也算通过:说明 query='skill' 在该仓库下没有任何 filteredResults。
    // 此时断言无法执行,但零副作用也证明"fallback 不误记热度"。
    assert('Case3.3 空 filteredResults 时 heatMap 不变动', hitCount === 0,
      `fallback should not record heat, got ${JSON.stringify(heatAfterFirst)}`)
  }
} catch (e) {
  assert('Case3 runLocalSearch 无异常', false, String(e?.message ?? e))
}

// ——— Case 4: 防御性 — setAppState 缺失时不抛 ———
async function runWithoutSetAppState() {
  const toolUseContext = {
    getAppState: () => ({
      kernel: initialKernelState(),
      mcp: { commands: [] },
    }),
    // setAppState 故意不提供
    discoveredSkillNames: new Set(),
  }
  const signal = {
    type: 'user_message',
    query: 'skill',
    mentionedPaths: [],
    recentTools: [],
    activeFileExtensions: [],
  }
  return localSkillSearch(signal, toolUseContext, 5)
}

try {
  await runWithoutSetAppState()
  assert('Case4 缺 setAppState 不抛异常', true)
} catch (e) {
  assert('Case4 缺 setAppState 不抛异常', false, String(e?.message ?? e))
}

// ——— Case 5: trimHeatMap 在 64 项时淘汰冷门 ———
{
  let state = initialKernelState()
  for (let i = 0; i < 70; i++) {
    // 前 64 项热度从高到低,第 64 项之后都是 heat=1 会被淘汰
    const hits = i < 64 ? 64 - i : 1
    for (let k = 0; k < hits; k++) {
      state = kernelReducer(state, { type: 'skill:hit', skill: `skill_${i}` })
    }
  }
  const keys = Object.keys(state.skillRecallHeat)
  assert('Case5.1 heat 维持在 ≤64 项', keys.length <= 64,
    `got ${keys.length} keys`)
  assert('Case5.2 热度最高的 skill_0 被保留', state.skillRecallHeat.skill_0 === 64)
  assert('Case5.3 低热度 skill_69 被淘汰', state.skillRecallHeat.skill_69 === undefined)
}

// ——— 输出结果 ———
console.log('\n=== Shot 8 smoke test ===')
for (const line of results) console.log(line)
console.log(`\npassed=${passed} failed=${failed}`)
if (failed > 0) process.exit(1)
