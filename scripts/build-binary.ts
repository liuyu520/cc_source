#!/usr/bin/env bun
// Compile the CLI into a single standalone binary at bin/claude.
//
// The restored source tree has many optional/unrecovered imports and some
// types.ts files with missing re-exports. `bun run` resolves these lazily
// and works fine, but `bun build --compile` does strict static ESM
// analysis, so we have to paper over the gaps at build time:
//
//   1. Write empty stub files for missing *relative* imports.
//   2. Append missing re-exports to certain types.ts files.
//   3. Pass --external for missing *bare* optional deps.
//   4. Run `bun build --compile` → writes bin/claude binary.
//   5. Clean up everything we modified (always, even on failure).

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const BIN_DIR = join(ROOT, 'bin')
const BIN_OUT = join(BIN_DIR, 'claude')
const BIN_BACKUP = join(BIN_DIR, 'claude.sh.bak')

// --- Missing relative imports → empty stub files ---
const MISSING_RELATIVE = [
  'src/tools/REPLTool/REPLTool.ts',
  'src/tools/SuggestBackgroundPRTool/SuggestBackgroundPRTool.ts',
  'src/tools/VerifyPlanExecutionTool/VerifyPlanExecutionTool.ts',
  'src/components/agents/SnapshotUpdateDialog.tsx',
  'src/assistant/AssistantSessionChooser.tsx',
  'src/commands/assistant/assistant.ts',
  'src/ink/devtools.ts',
  'src/services/compact/cachedMicrocompact.ts',
]

// --- Missing bare optional deps ---
const MISSING_BARE = [
  '@opentelemetry/exporter-prometheus',
  '@opentelemetry/exporter-logs-otlp-grpc',
  '@opentelemetry/exporter-logs-otlp-http',
  '@opentelemetry/exporter-logs-otlp-proto',
  '@opentelemetry/exporter-trace-otlp-grpc',
  '@opentelemetry/exporter-trace-otlp-http',
  '@opentelemetry/exporter-trace-otlp-proto',
  '@opentelemetry/exporter-metrics-otlp-grpc',
  '@opentelemetry/exporter-metrics-otlp-http',
  '@opentelemetry/exporter-metrics-otlp-proto',
  '@aws-sdk/client-bedrock',
  '@aws-sdk/client-sts',
  '@anthropic-ai/bedrock-sdk',
  '@anthropic-ai/foundry-sdk',
  '@anthropic-ai/vertex-sdk',
  '@azure/identity',
  'turndown',
  'sharp',
]

// --- Missing re-exports to append to existing files ---
// { file: [ "append" ] } — text is concatenated after the current content.
const APPEND_EXPORTS: Record<string, string> = {
  'src/utils/filePersistence/types.ts': `
// --- build-binary.ts appended stubs ---
export const DEFAULT_UPLOAD_CONCURRENCY = 4
export const FILE_COUNT_LIMIT = 1000
export const OUTPUTS_SUBDIR = 'outputs'
export type FailedPersistence = { path: string; error: string }
export type FilesPersistedEventData = { count: number; bytes: number }
export type PersistedFile = { path: string; fileId: string }
`,
}

const STUB_CONTENT = `// Auto-generated build-time stub — do not commit.
export default {};
export const __stub = true;
`

const createdFiles: string[] = []
const patchedFiles: { path: string; original: string }[] = []
let binBackedUp = false

function writeStub(rel: string): void {
  const abs = join(ROOT, rel)
  if (existsSync(abs)) return
  const dir = dirname(abs)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(abs, STUB_CONTENT)
  createdFiles.push(abs)
}

function appendPatch(rel: string, text: string): void {
  const abs = join(ROOT, rel)
  if (!existsSync(abs)) {
    // File doesn't exist at all — create it from scratch with just the patch.
    const dir = dirname(abs)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(abs, text)
    createdFiles.push(abs)
    return
  }
  const original = readFileSync(abs, 'utf8')
  if (original.includes('build-binary.ts appended stubs')) return // idempotent
  writeFileSync(abs, original + text)
  patchedFiles.push({ path: abs, original })
}

function cleanup(): void {
  for (const f of createdFiles) {
    try { rmSync(f) } catch {}
  }
  for (const p of patchedFiles) {
    try { writeFileSync(p.path, p.original) } catch {}
  }
  if (binBackedUp && existsSync(BIN_BACKUP)) {
    // Leave the compiled binary in place but restore the shell script as
    // claude.sh next to it so package-runtime.sh still has something.
    // Actually we *want* the shell script gone on success, so only restore
    // when no binary was produced.
    if (!existsSync(BIN_OUT)) {
      try { writeFileSync(BIN_OUT, readFileSync(BIN_BACKUP)) } catch {}
    }
  }
}

process.on('uncaughtException', e => { cleanup(); throw e })
process.on('exit', () => cleanup())

try {
  console.log('[build-binary] preparing stubs and patches')
  for (const rel of MISSING_RELATIVE) writeStub(rel)
  for (const [rel, text] of Object.entries(APPEND_EXPORTS)) appendPatch(rel, text)

  // Back up the existing bin/claude shell launcher — we're about to replace
  // it with the compiled binary.
  if (existsSync(BIN_OUT)) {
    const original = readFileSync(BIN_OUT)
    writeFileSync(BIN_BACKUP, original)
    binBackedUp = true
    rmSync(BIN_OUT)
  }
  if (!existsSync(BIN_DIR)) mkdirSync(BIN_DIR, { recursive: true })

  const platform = process.platform === 'darwin' ? 'darwin' : process.platform
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch

  const externalArgs: string[] = []
  for (const name of MISSING_BARE) externalArgs.push('--external', name)
  externalArgs.push('--external', '*.node')

  console.log(`[build-binary] compiling -> ${BIN_OUT}`)
  const result = spawnSync(
    'bun',
    [
      'build',
      '--compile',
      '--target', `bun-${platform}-${arch}`,
      'src/bootstrap-entry.ts',
      '--outfile', BIN_OUT,
      ...externalArgs,
    ],
    { stdio: 'inherit', cwd: ROOT },
  )
  if (result.status !== 0) process.exit(result.status ?? 1)

  // On success, remove the backup of the shell script.
  if (existsSync(BIN_BACKUP)) rmSync(BIN_BACKUP)
  binBackedUp = false
  console.log(`[build-binary] done: ${BIN_OUT}`)
} catch (e) {
  cleanup()
  throw e
}
