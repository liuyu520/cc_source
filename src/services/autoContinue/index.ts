// Auto-Continue 策略注册表对外出口。
//
// 使用:
//   import { registerAutoContinueStrategy, evaluateAutoContinue } from '.../autoContinue'
//   registerAutoContinueStrategy({
//     name: 'my-strategy',
//     priority: 50,
//     detect: ctx => /.../.test(ctx.text ?? ''),
//     prompt: () => 'please continue',
//     isEnabled: () => process.env.MY_STRATEGY === '1',
//   })
//
// 命中后可在 /kernel-status "Auto-Continue Strategies" 节看到 hits 计数。
export {
  registerAutoContinueStrategy,
  evaluateAutoContinue,
  getAllAutoContinueStrategies,
  getAutoContinueHits,
  __resetAutoContinueRegistryForTests,
} from './strategyRegistry.js'

export type {
  AutoContinueContext,
  AutoContinueDecision,
  AutoContinueStrategy,
  AutoContinueStrategySnapshot,
  RegisterAutoContinueStrategyOptions,
} from './strategyRegistry.js'
