/**
 * Rate Bucket — 通用滑窗速率限流器(re-exports)
 *
 * 使用示例:
 *   const bucket = createRateBucket({
 *     dimension: 'output-tokens',
 *     windowMs: 60_000,
 *     limit: () => Number(process.env.MAX_OUTPUT_TOKENS_PER_MINUTE) || Infinity,
 *   })
 *   if (bucket.tryCharge(estimatedOutputTokens)) { ... }
 *
 * 注册到 /kernel-status: 默认 registerInRegistry = true,自动可见。
 */
export {
  createRateBucket,
  getAllRateBuckets,
  getRateBucketByDimension,
  __resetBucketRegistryForTests,
} from './createBucket.js'

export type {
  RateBucket,
  RateBucketSnapshot,
  CreateRateBucketOptions,
} from './createBucket.js'
