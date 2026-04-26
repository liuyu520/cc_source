/**
 * Cron grace window + at-most-once helpers.
 *
 * Ported from hermes-agent `jobs.py:252-281`. Problem we guard against:
 * after a long downtime / sleep / laptop-lid-close, every cron whose
 * nextRunAt is in the past will fire back-to-back on the first tick after
 * resume. That thunders the LLM provider and repeats tasks that have
 * already lost their "now" context.
 *
 * Behavior (opt-in, CLAUDE_CODE_CRON_GRACE_WINDOW=1):
 *   - If `(now - scheduledAt) > graceMs`, the task is "stale" — skip this
 *     fire and fast-forward to the next future occurrence.
 *   - Grace window is derived from the cron expression's own cadence: half
 *     the gap between two consecutive firings, clamped to [2min, 2h]. A
 *     per-minute cron thus gets ~30s tolerance, hourly gets ~30min, daily
 *     gets the 2h cap.
 *
 * All helpers reuse existing `nextCronRunMs` from `cronTasks.ts` so there
 * is no new cron-parser dependency — just extra arithmetic on top.
 */

import { nextCronRunMs } from './cronTasks.js'

const MIN_GRACE_MS = 2 * 60 * 1000 // 120s
const MAX_GRACE_MS = 2 * 60 * 60 * 1000 // 7200s (2h)

function isEnvTruthy(raw: string | undefined): boolean {
  if (!raw) return false
  const v = raw.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

/**
 * Master feature switch. Default OFF per plan — behavior change is "skip
 * stale fires after sleep/downtime" which is safer than the current
 * "catch up all misses at once", but we let the user opt in explicitly so
 * nothing shifts without consent.
 */
export function isCronGraceWindowEnabled(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_CRON_GRACE_WINDOW)
}

/**
 * Compute grace window (ms) for a given cron expression. Algorithm:
 *   - Take two consecutive firings after now; grace = (t2 - t1) / 2.
 *   - Clamp to [MIN_GRACE_MS, MAX_GRACE_MS].
 *   - If cron is invalid or has no future match, return MIN_GRACE_MS.
 */
export function computeGraceMs(cron: string, nowMs: number = Date.now()): number {
  const t1 = nextCronRunMs(cron, nowMs)
  if (t1 === null) return MIN_GRACE_MS
  const t2 = nextCronRunMs(cron, t1)
  if (t2 === null) return MIN_GRACE_MS
  const delta = Math.max(0, t2 - t1)
  const grace = Math.floor(delta / 2)
  return Math.max(MIN_GRACE_MS, Math.min(MAX_GRACE_MS, grace))
}

/**
 * Decide whether a scheduled fire is too stale to run. True → caller should
 * advance nextRunAt past `nowMs` without invoking the task body.
 */
export function shouldFastForward(
  cron: string,
  scheduledAtMs: number,
  nowMs: number = Date.now(),
): boolean {
  if (!isCronGraceWindowEnabled()) return false
  if (scheduledAtMs === Infinity) return false
  if (nowMs < scheduledAtMs) return false
  const lateness = nowMs - scheduledAtMs
  const graceMs = computeGraceMs(cron, nowMs)
  return lateness > graceMs
}

/**
 * Compute the next cron fire strictly after `nowMs`. Wrapper that exists
 * for symmetry with shouldFastForward — callers already have nextCronRunMs
 * imported, but routing fast-forward through this name makes the intent
 * explicit in the scheduler.
 *
 * Returns null if the cron expression has no match in the next year. The
 * scheduler treats null the same as Infinity — the task is dormant.
 */
export function computeNextFutureOccurrence(
  cron: string,
  nowMs: number = Date.now(),
): number | null {
  return nextCronRunMs(cron, nowMs)
}
