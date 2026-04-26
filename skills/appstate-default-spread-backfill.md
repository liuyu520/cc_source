# AppState 手写字面量的默认值兜底(spread 兜底模式)

## 适用场景

当项目有**集中式 store 默认值工厂**(`getDefaultAppState()`、`initialKernelState()` 等),但在某些入口文件里又**手写完整 `initialState` 字面量**赋值给 `AppState` 类型时。

核心风险:store 类型加了新字段(`kernel`、`agentScheduler`、...),默认值工厂里加了,但**手写字面量的地方漏掉了**——TypeScript 在 `strict: false` 模式或字段为 optional 时完全不会报错,运行时一旦下游代码读 `appState.kernel.openHypotheses`,就是 `undefined is not an object` 并静默炸。

## 真实案例:codex 模式 "hi" 无响应

`src/main.tsx:3001` 手写:

```ts
const initialState: AppState = {
  settings: getInitialSettings(),
  tasks: {},
  agentNameRegistry: new Map(),
  // ... 40 多个字段,全部手写
  // ❌ 缺失 kernel、agentScheduler 这两个后来加的字段
}
```

而 `src/state/AppStateStore.ts` 的 `getDefaultAppState()` 里已经带上了:

```ts
return {
  // ...
  agentScheduler: { ... },
  kernel: initialKernelState(),
}
```

但 main.tsx 没有 spread 它,直接把不完整的 literal 灌给 `createStore(initialState)`。

下游 `queryLoop` 读取时:

```ts
openHypothesisTags: toolUseContext.getAppState().kernel.openHypotheses.map(h => h.tag)
```

抛 `TypeError: undefined is not an object (evaluating 'kernel.openHypotheses')`——而且是在 generator 的**参数构造阶段**抛,generator 直接被静默终结(详见 [generator-argbuild-silent-throw.md](generator-argbuild-silent-throw.md)),UI 上什么都不显示,输入 "hi" 就永远 Pending。

## 修法:一行 spread 兜底

```ts
const initialState: AppState = {
  // 兜底:先用 getDefaultAppState() 的默认值,避免 kernel/agentScheduler 等
  // 新字段在此处被漏掉导致下游读取时 undefined。下面的手写字段会覆盖默认值。
  ...getDefaultAppState(),
  settings: getInitialSettings(),
  tasks: {},
  // ... 原有手写字段继续保留,会 override 默认值
}
```

**这是 O(1) 修改,且"兜底 + 覆盖"语义让所有原有意图都保留**。

## 识别这个陷阱的启发式

项目里存在这些信号就要警惕:

1. **有 `getDefaultAppState()` / `getInitialXxxState()` 这种默认值工厂**,同时又有多处手写完整字面量。
2. **Store 类型是渐进式增长的**(看 `git log` 对 `AppState` / `AppStateStore.ts` 的变更 — 每次加字段就是一次风险窗口)。
3. **手写字面量字段 ≥ 20 个**——开发者很难在 review 里发现漏掉哪一个。
4. **TypeScript 配置 `strict: false`**——missing required prop 不会报错。

## 通用原则

> **在同一个 type 上,永远优先"spread 默认值 + 覆盖"而非"完整手写"。**

即便当前字段对齐,未来加字段时也不需要每个入口都同步修改——单点维护默认值工厂就够了。

反过来,**如果某处必须手写完整字面量**(例如要刻意拒绝某些默认值),加注释说明理由,并在工厂更新时加 CI / grep 提醒:

```ts
// ⚠️ 故意不 spread getDefaultAppState():此路径需要干净 state。
// 若 AppState 加字段且需要影响此处,请同步补齐。
const initialState: AppState = { ... }
```

## 排查清单

当你遇到"生产环境某路径无响应 / 某功能静默失效"时,按顺序排:

- [ ] 这个功能用到了 `appState.<newField>` 吗?
- [ ] 对应的 `<newField>` 在 store 默认值工厂里吗?
- [ ] 所有 `createStore(...)` / `new Store(...)` 的调用点,传入的 state 包含 `<newField>` 吗?
  - `grep -rn "createStore\|initialState: AppState" src/`
- [ ] 在入口文件里是"spread 默认值 + 覆盖",还是"完整手写"?
- [ ] 如果是完整手写,加 `...getDefaultAppState()` 即可。

## 相关 skill

- [generator-argbuild-silent-throw.md](generator-argbuild-silent-throw.md) — 解释为什么 `kernel.openHypotheses` 抛错会"完全无声"
- [silent-catch-misleading-symptoms.md](silent-catch-misleading-symptoms.md) — 另一类"症状和真凶对不上"的排查思路
- [dead-code-callsite-audit.md](dead-code-callsite-audit.md) — "实现完整但调用点缺失"的姊妹问题,都是集成环节的盲点
