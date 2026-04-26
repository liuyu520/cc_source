#!/usr/bin/env bun
// Dream Pipeline health snapshot (read-only, zero side effects).
//
// What it does:
//   - Prints the three CLAUDE_DREAM_PIPELINE_* env switches (incl. the
//     SHADOW default=true subtle trap that silently pins dispatch to legacy)
//   - Reports journal.ndjson existence/size and the tail N evidences
//   - Reports project memdir: MEMORY.md, episodes/, consolidate-lock
//   - Does NOT write, does NOT fork, does NOT call any LLM
//
// Run:
//   bun run scripts/dream-status.ts
//
// Rationale: this replaces blind `-p --print --bare` smoke runs. autoDream
// fires on real session turn-end; the only honest way to observe it is to
// look at the artifacts it leaves on disk, not to spin up a fake headless.

import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Reuse the real path resolver from the pipeline — single source of truth.
import { journalFilePath, listRecent } from '../src/services/autoDream/pipeline/journal.js'
import {
  isDreamPipelineEnabled,
  isDreamPipelineShadow,
  isDreamMicroEnabled,
} from '../src/services/autoDream/pipeline/featureCheck.js'
// Reuse the real sanitizer used by getProjectDir — avoids a second truth source.
import { sanitizePath } from '../src/utils/sessionStoragePortable.js'

function fmtEnv(name: string): string {
  const v = process.env[name]
  return v === undefined ? '(unset)' : JSON.stringify(v)
}

function fmtBool(b: boolean): string {
  return b ? 'YES' : 'NO '
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${(n / 1024 / 1024).toFixed(2)}MB`
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`)
}

// ---------- 1. Env switches ----------
// Two sources matter:
//   (a) current shell env — what THIS diagnostic process sees
//   (b) settings.json > env — what Claude Code will inject on next startup
// Claude Code's startup applies settings env to process.env, so (b) is what
// matters for the real runtime even when (a) is stale.
section('Pipeline env switches')

type EnvView = { pipeline?: string; shadow?: string; micro?: string }
function readSettingsEnv(path: string): EnvView | null {
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as {
      env?: Record<string, string>
    }
    const env = parsed.env ?? {}
    return {
      pipeline: env.CLAUDE_DREAM_PIPELINE,
      shadow: env.CLAUDE_DREAM_PIPELINE_SHADOW,
      micro: env.CLAUDE_DREAM_PIPELINE_MICRO,
    }
  } catch {
    return null
  }
}
const settingsEnvPath = join(homedir(), '.claude', 'settings.json')
const settingsEnv = readSettingsEnv(settingsEnvPath)

const shellView: EnvView = {
  pipeline: process.env.CLAUDE_DREAM_PIPELINE,
  shadow: process.env.CLAUDE_DREAM_PIPELINE_SHADOW,
  micro: process.env.CLAUDE_DREAM_PIPELINE_MICRO,
}

function fmtView(v: EnvView, label: string): void {
  console.log(`  [${label}]`)
  console.log(`    CLAUDE_DREAM_PIPELINE         = ${v.pipeline === undefined ? '(unset → default=true)' : JSON.stringify(v.pipeline)}`)
  console.log(`    CLAUDE_DREAM_PIPELINE_SHADOW  = ${v.shadow === undefined ? '(unset → default=true)' : JSON.stringify(v.shadow)}`)
  console.log(`    CLAUDE_DREAM_PIPELINE_MICRO   = ${v.micro === undefined ? '(unset → default=true)' : JSON.stringify(v.micro)}`)
}
fmtView(shellView, 'current shell env (this process)')
if (settingsEnv) fmtView(settingsEnv, `settings.json (${settingsEnvPath})`)
else console.log('  (settings.json not found — shell env only)')

// Evaluation uses current process env (what the featureCheck helpers see).
console.log('')
console.log(`  → isDreamPipelineEnabled  : ${fmtBool(isDreamPipelineEnabled())}`)
console.log(`  → isDreamPipelineShadow   : ${fmtBool(isDreamPipelineShadow())}  ${isDreamPipelineShadow() ? '(dispatch pinned to legacy)' : '(cutover active)'}`)
console.log(`  → isDreamMicroEnabled     : ${fmtBool(isDreamMicroEnabled())}`)

const canDispatchMicro =
  isDreamPipelineEnabled() && !isDreamPipelineShadow() && isDreamMicroEnabled()
console.log('')
console.log(`  CAN dispatch micro (this process): ${fmtBool(canDispatchMicro)}`)
if (!canDispatchMicro) {
  console.log('  ⚠ micro path is NOT reachable from THIS process.')
}

// Project the settings.json view onto the same predicates — this is what the
// next real Claude Code run will actually see.
if (settingsEnv) {
  const sPipelineOn = !(settingsEnv.pipeline === '0' || settingsEnv.pipeline === 'false') // default true
  const sShadowOn = !(settingsEnv.shadow === '0' || settingsEnv.shadow === 'false') // default true
  const sMicroOn = !(settingsEnv.micro === '0' || settingsEnv.micro === 'false') // default true
  const sCanDispatch = sPipelineOn && !sShadowOn && sMicroOn
  console.log(`  CAN dispatch micro (next Claude Code run): ${fmtBool(sCanDispatch)}`)
}

// ---------- 2. autoDreamEnabled setting ----------
section('User setting (autoDreamEnabled)')
const settingsCandidates = [
  join(homedir(), '.claude', 'settings.json'),
  join(homedir(), '.claude', 'settings_new.json'),
]
for (const path of settingsCandidates) {
  if (!existsSync(path)) {
    console.log(`  ${path}  (not found)`)
    continue
  }
  try {
    const raw = readFileSync(path, 'utf-8')
    const parsed = JSON.parse(raw) as { autoDreamEnabled?: unknown }
    console.log(`  ${path}  autoDreamEnabled=${JSON.stringify(parsed.autoDreamEnabled)}`)
  } catch (e) {
    console.log(`  ${path}  (parse failed: ${(e as Error).message})`)
  }
}

// ---------- 3. journal.ndjson ----------
section('Evidence journal')
const jp = journalFilePath()
console.log(`  path: ${jp}`)
if (!existsSync(jp)) {
  console.log('  status: NOT FOUND — no evidence has ever been captured')
  console.log('  ⇒ captureEvidence() never fired (pipeline disabled at write time, or autoDream turn-end hook never ran)')
} else {
  const st = statSync(jp)
  const raw = readFileSync(jp, 'utf-8')
  const lines = raw.split('\n').filter(Boolean)
  console.log(`  size: ${fmtBytes(st.size)}   lines: ${lines.length}`)
  console.log(`  mtime: ${st.mtime.toISOString()}`)

  const recent24h = listRecent(24 * 3600 * 1000)
  const recent7d = listRecent(7 * 24 * 3600 * 1000)
  console.log(`  evidences in last 24h: ${recent24h.length}`)
  console.log(`  evidences in last 7d : ${recent7d.length}`)

  const tail = lines.slice(-3)
  if (tail.length > 0) {
    console.log('  tail (last 3):')
    for (const line of tail) {
      try {
        const ev = JSON.parse(line) as Record<string, unknown>
        console.log(
          `    - ${ev.sessionId} @ ${ev.endedAt}  novelty=${ev.novelty} ` +
            `surprise=${ev.surprise} toolErr=${ev.toolErrorRate} files=${ev.filesTouched}`,
        )
      } catch {
        console.log(`    - (corrupt line: ${line.slice(0, 80)}…)`)
      }
    }
  }
}

// ---------- 4. Project memdir ----------
section('Project memdir (episodes & lock)')
// Use the real sanitizer that the runtime uses in getProjectDir() so this
// matches exactly one directory (not a fuzzy substring search).
const cwd = process.cwd()
const projectsDir = join(homedir(), '.claude', 'projects')
const expectedProjectName = sanitizePath(cwd)
const memdir = join(projectsDir, expectedProjectName, 'memory')
console.log(`  cwd:                 ${cwd}`)
console.log(`  expected project:    ${expectedProjectName}`)
console.log(`  memdir:              ${memdir}`)
if (existsSync(memdir)) {
  const files = readdirSync(memdir)
  const memoryMd = files.includes('MEMORY.md') ? 'YES' : 'no'
  const hasEpisodes = files.includes('episodes')
  const lockPath = join(memdir, '.consolidate-lock')
  const lockMtime = existsSync(lockPath)
    ? statSync(lockPath).mtime.toISOString()
    : '(no lock file)'
  console.log(`    MEMORY.md present  : ${memoryMd}`)
  console.log(`    episodes/ present  : ${hasEpisodes ? 'YES' : 'NO  ← micro dream never persisted any cards'}`)
  console.log(`    .consolidate-lock  : ${lockMtime}`)
  if (hasEpisodes) {
    const epDir = join(memdir, 'episodes')
    const cards = readdirSync(epDir).filter(f => f.endsWith('.episode.md'))
    console.log(`    episodic cards     : ${cards.length}`)
    for (const c of cards.slice(-3)) {
      console.log(`      - ${c}`)
    }
  }
} else {
  console.log('  memdir does not exist (legacy autoDream has not run in this cwd yet)')
}

// ---------- 5. Actionable diagnosis ----------
// Diagnosis must reason about the NEXT real Claude Code run (which applies
// settings.json > env), not THIS diagnostic process (where the shell env may
// be stale). settings.json is the source of truth for user-facing config.
section('Diagnosis')
const effective = settingsEnv ?? shellView
const effPipeline = !(effective.pipeline === '0' || effective.pipeline === 'false')
const effShadow = !(effective.shadow === '0' || effective.shadow === 'false') // default true
const effMicro = !(effective.micro === '0' || effective.micro === 'false')

if (!effPipeline) {
  console.log('  ✗ Pipeline OFF — remove the opt-out or set "CLAUDE_DREAM_PIPELINE": "1" in ~/.claude/settings.json > env')
} else if (effShadow) {
  console.log('  ✗ Shadow mode ON (default) — micro/full cannot dispatch.')
  console.log('    Fix: add "CLAUDE_DREAM_PIPELINE_SHADOW": "0" to ~/.claude/settings.json > env')
} else if (!effMicro) {
  console.log('  ✗ micro disabled — remove the opt-out or set "CLAUDE_DREAM_PIPELINE_MICRO": "1" in ~/.claude/settings.json > env')
} else if (!existsSync(jp)) {
  console.log('  ▸ All env switches OK in settings.json.')
  console.log('  ▸ Waiting for next real Claude Code session turn-end to populate journal.ndjson.')
  console.log('  ▸ Re-run this script after your next session ends to confirm capture.')
} else {
  const recent = listRecent(24 * 3600 * 1000)
  if (recent.length === 0) {
    console.log('  ▸ journal exists but is empty in last 24h — evidence will accumulate as sessions end.')
  } else {
    console.log(`  ✓ Pipeline is capturing: ${recent.length} evidences in last 24h.`)
    console.log('    If episodes/ still empty, triage score may not yet have reached "micro" threshold.')
  }
}
console.log('')
