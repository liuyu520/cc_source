/**
 * Kind Installer — Phase 14:把晋升到 stable 的非 skill organism 自动挂接
 * 到 Claude Code 的对应加载器目录,stable 出口时自动回收。
 *
 * 背景:
 *   Phase 13 让 skillCompiler 按 kind 生成正确格式的 body(command→<name>.md,
 *   agent→<name>.md,hook→hook.sh+hook.config.json,prompt→PROMPT.md)。
 *   但那些 body 还住在 ~/.claude/autoEvolve/genome/stable/<id>/ 里,
 *   Claude Code 的 command loader 只扫 ~/.claude/commands/,agent loader 只
 *   扫 ~/.claude/agents/ —— 这意味着 Phase 13 产物"已经是对的格式",却
 *   "还没落位"。
 *
 *   Phase 14 打通这一步:晋升到 stable 时,按 kind 把 body 安装到对应
 *   loader 目录(command/agent 走 symlink,hook 走 copy+挂接队列);
 *   出 stable 时(archive/veto)反向撤销。skill kind 走的是 Phase 4 的
 *   registerStableGenomeAsSkillDir 路径,不归这里管。
 *
 * 设计纪律:
 *   1. 不覆盖用户已有文件 —— symlink 目标若已存在(不管是用户手写的
 *      还是其它来源的 symlink 指向别处),一律 skip + warn。只有"我们
 *      的 symlink 指向自家 orgDir"才算幂等复用。
 *   2. 不动 settings.json —— hook 挂接本身需要 user 改 settings.json,
 *      autoEvolve 不能越权。改为:copy hook.sh 到规范目录 + append 到
 *      pending-hooks.ndjson 排队等人工处理。
 *   3. 失败静默 —— install/uninstall 失败只返回 warnings,不抛异常、
 *      不回滚 promotion(promotion ledger 已签名,不能反悔)。
 *   4. 幂等 —— 反复调用 install(如重复 promote-to-stable)不会报错,
 *      重复的 pending-hooks 条目也不阻塞(/evolve-status 会合并展示)。
 *   5. 真实文件操作,不做 mock / dry-run(dry-run 模式如果需要由调用
 *      方在外层控制)。
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { logForDebugging } from '../../../utils/debug.js'
import {
  ensureDir,
  getClaudeAgentsInstallDir,
  getClaudeCommandsInstallDir,
  getInstalledHooksDir,
  getPendingHooksPath,
} from '../paths.js'
import type { OrganismManifest } from '../types.js'
import { appendJsonLine } from '../oracle/ndjsonLedger.js'

// ── 返回协议 ────────────────────────────────────────────────

export interface InstallResult {
  /** organism kind */
  kind: OrganismManifest['kind']
  /** 本次是否"真的做了事"(symlink 创建 / 文件拷贝)。幂等复用算 false */
  installed: boolean
  /** 解释 installed 为 false 的原因(或 installed 为 true 时的补充说明) */
  reason: string
  /** 本次创建/符号链接/拷贝的文件绝对路径(供 uninstall 或展示用) */
  artifacts: string[]
  /** 非致命警告(存在同名用户文件被跳过等) */
  warnings: string[]
}

export interface UninstallResult {
  kind: OrganismManifest['kind']
  cleaned: boolean
  reason: string
  artifacts: string[]
  warnings: string[]
}

// ── symlink 安全原子 ────────────────────────────────────────

type SymlinkOutcome =
  | 'created'
  | 'existed-correct'
  | 'skip-user-file'
  | 'skip-other-symlink'
  | 'error'

/**
 * 安全 symlink:绝不覆盖已有文件 / 别家的 symlink。
 *
 * 返回值告诉调用方"到底发生了什么":
 *   - 'created'            本次新建了 symlink
 *   - 'existed-correct'    已有 symlink 且指向目标源,幂等复用
 *   - 'skip-user-file'     目标路径存在真文件,跳过(保护用户)
 *   - 'skip-other-symlink' 目标路径是 symlink 但指向别处,跳过
 *   - 'error'              fs 操作异常
 */
function symlinkSafe(
  srcAbs: string,
  dstAbs: string,
): { outcome: SymlinkOutcome; detail?: string } {
  // 1. 目标不存在 → 建立新 symlink
  // lstatSync 不跟随 symlink,这样即使 dst 是 dangling symlink 也能探测到
  let stat: ReturnType<typeof lstatSync> | null = null
  try {
    stat = lstatSync(dstAbs)
  } catch {
    stat = null
  }

  if (stat === null) {
    try {
      symlinkSync(srcAbs, dstAbs)
      return { outcome: 'created' }
    } catch (e) {
      return { outcome: 'error', detail: (e as Error).message }
    }
  }

  // 2. 目标存在且是 symlink → 读 link,比对
  if (stat.isSymbolicLink()) {
    try {
      const target = readlinkSync(dstAbs)
      // 解析相对路径(symlinkSync 通常保存绝对路径,但用 resolve 兼容)
      const targetAbs = resolve(dstAbs, '..', target)
      if (targetAbs === srcAbs) {
        return { outcome: 'existed-correct' }
      }
      return {
        outcome: 'skip-other-symlink',
        detail: `symlink points to ${targetAbs}, not ${srcAbs}`,
      }
    } catch (e) {
      return { outcome: 'error', detail: (e as Error).message }
    }
  }

  // 3. 目标是真文件 / 目录 → 不碰
  return { outcome: 'skip-user-file', detail: `dst exists as non-symlink` }
}

// ── hook.config.json 提示读取(Phase 45)──────────────────

/**
 * 从 hook.config.json 读 `suggestedEvent` / `suggestedMatcher`,供 pending-hooks
 * install event 消费。
 *
 * Why:
 *   Phase 45 的 renderHookBody 对 tool-failure 候选会写入结构化 matcher
 *   (toolName,exact 匹配),通用候选保留 'TODO-reviewer-fill-matcher'。
 *   之前 kindInstaller 硬编码覆盖这两个字段,结构化信息被丢弃,
 *   /evolve-install-hook 永远拿到 TODO → Phase 45 的自动化空转。
 *
 * Fail-open:
 *   config.json 不存在 / 解析失败 / 字段类型不对 → 返回与旧硬编码
 *   等价的默认值,不影响主安装流程(那是 promotion ledger 已签名的
 *   不可逆流程)。
 */
function readHookConfigHints(cfgPath: string): {
  suggestedEvent: string
  suggestedMatcher: string
} {
  const FALLBACK = {
    suggestedEvent: 'PreToolUse',
    suggestedMatcher: 'TODO-reviewer-fill-matcher',
  }
  try {
    if (!existsSync(cfgPath)) return FALLBACK
    const raw = readFileSync(cfgPath, 'utf8')
    const parsed = JSON.parse(raw) as {
      suggestedEvent?: unknown
      suggestedMatcher?: unknown
    }
    const ev =
      typeof parsed.suggestedEvent === 'string' &&
      parsed.suggestedEvent.trim().length > 0
        ? parsed.suggestedEvent
        : FALLBACK.suggestedEvent
    // suggestedMatcher 允许空字符串(match-all 语义),但必须是 string
    const m =
      typeof parsed.suggestedMatcher === 'string'
        ? parsed.suggestedMatcher
        : FALLBACK.suggestedMatcher
    return { suggestedEvent: ev, suggestedMatcher: m }
  } catch {
    return FALLBACK
  }
}

// ── install / uninstall 主入口 ─────────────────────────────

/**
 * 晋升 organism 到 stable 后的 kind 特化安装。
 *
 * 调用点:arenaController.promoteOrganism step 6(stable 分支),与
 * registerStableGenomeAsSkillDir 同级;registerStableGenomeAsSkillDir
 * 处理 skill kind 的 loader 挂接,本函数处理 command/agent/hook 的安装。
 */
export function installKindIntoClaudeDirs(
  manifest: OrganismManifest,
  orgDir: string,
): InstallResult {
  const kind = manifest.kind
  const name = manifest.name

  switch (kind) {
    case 'skill':
      // skill 由 Phase 4 的 registerStableGenomeAsSkillDir 自动挂接
      return {
        kind,
        installed: false,
        reason: 'handled-by-registerStableGenomeAsSkillDir (Phase 4)',
        artifacts: [],
        warnings: [],
      }

    case 'prompt':
      // prompt 是可复用提示素材,不需要落进 loader 目录
      return {
        kind,
        installed: false,
        reason: 'prompt kind is reference-only, no loader install',
        artifacts: [],
        warnings: [],
      }

    case 'command': {
      const warnings: string[] = []
      const srcAbs = resolve(join(orgDir, `${name}.md`))
      const commandsDir = getClaudeCommandsInstallDir()
      ensureDir(commandsDir)
      const dstAbs = resolve(join(commandsDir, `${name}.md`))

      if (!existsSync(srcAbs)) {
        return {
          kind,
          installed: false,
          reason: `command body missing at ${srcAbs}`,
          artifacts: [],
          warnings: [`source ${srcAbs} not found`],
        }
      }

      const { outcome, detail } = symlinkSafe(srcAbs, dstAbs)
      if (outcome === 'created') {
        logForDebugging(
          `[autoEvolve:installer] command symlinked: ${dstAbs} → ${srcAbs}`,
        )
        return {
          kind,
          installed: true,
          reason: `command symlinked to ${dstAbs}`,
          artifacts: [dstAbs],
          warnings,
        }
      }
      if (outcome === 'existed-correct') {
        return {
          kind,
          installed: false,
          reason: `command symlink already present at ${dstAbs} (idempotent)`,
          artifacts: [dstAbs],
          warnings,
        }
      }
      // skip-user-file / skip-other-symlink / error
      warnings.push(`symlink ${dstAbs}: ${outcome} (${detail ?? ''})`)
      return {
        kind,
        installed: false,
        reason: `command install skipped: ${outcome}`,
        artifacts: [],
        warnings,
      }
    }

    case 'agent': {
      const warnings: string[] = []
      const srcAbs = resolve(join(orgDir, `${name}.md`))
      const agentsDir = getClaudeAgentsInstallDir()
      ensureDir(agentsDir)
      const dstAbs = resolve(join(agentsDir, `${name}.md`))

      if (!existsSync(srcAbs)) {
        return {
          kind,
          installed: false,
          reason: `agent body missing at ${srcAbs}`,
          artifacts: [],
          warnings: [`source ${srcAbs} not found`],
        }
      }

      const { outcome, detail } = symlinkSafe(srcAbs, dstAbs)
      if (outcome === 'created') {
        logForDebugging(
          `[autoEvolve:installer] agent symlinked: ${dstAbs} → ${srcAbs}`,
        )
        return {
          kind,
          installed: true,
          reason: `agent symlinked to ${dstAbs}`,
          artifacts: [dstAbs],
          warnings,
        }
      }
      if (outcome === 'existed-correct') {
        return {
          kind,
          installed: false,
          reason: `agent symlink already present at ${dstAbs} (idempotent)`,
          artifacts: [dstAbs],
          warnings,
        }
      }
      warnings.push(`symlink ${dstAbs}: ${outcome} (${detail ?? ''})`)
      return {
        kind,
        installed: false,
        reason: `agent install skipped: ${outcome}`,
        artifacts: [],
        warnings,
      }
    }

    case 'hook': {
      const warnings: string[] = []
      const artifacts: string[] = []
      const srcSh = resolve(join(orgDir, 'hook.sh'))
      if (!existsSync(srcSh)) {
        return {
          kind,
          installed: false,
          reason: `hook.sh missing at ${srcSh}`,
          artifacts: [],
          warnings: [`source ${srcSh} not found`],
        }
      }

      // 拷到 ~/.claude/autoEvolve/installed-hooks/<id>/hook.sh + chmod 0755
      // —— 保留 hook.config.json 也一起拷贝,/evolve-status 可以直接读
      //    structured hint 给 reviewer。
      const hookInstallRoot = getInstalledHooksDir()
      const idDir = join(hookInstallRoot, manifest.id)
      ensureDir(idDir)
      const dstSh = resolve(join(idDir, 'hook.sh'))
      const srcCfg = resolve(join(orgDir, 'hook.config.json'))
      const dstCfg = resolve(join(idDir, 'hook.config.json'))

      try {
        copyFileSync(srcSh, dstSh)
        chmodSync(dstSh, 0o755)
        artifacts.push(dstSh)
      } catch (e) {
        return {
          kind,
          installed: false,
          reason: `copy hook.sh failed: ${(e as Error).message}`,
          artifacts,
          warnings,
        }
      }
      if (existsSync(srcCfg)) {
        try {
          copyFileSync(srcCfg, dstCfg)
          artifacts.push(dstCfg)
        } catch (e) {
          warnings.push(`copy hook.config.json failed: ${(e as Error).message}`)
        }
      }

      // 把一条 "install" 动作写进 pending-hooks.ndjson(Phase 12 appendJsonLine
      // 会自动处理 10MB rotation),reviewer 读这个队列决定是否粘贴到 settings.json
      //
      // Phase 45 修复:以前这里硬编码 suggestedEvent/suggestedMatcher,
      // 让 Phase 45 renderHookBody 精心写入 hook.config.json 的结构化
      // (tool-failure:matcher=toolName)被直接丢弃 → /evolve-install-hook
      // 拿到的永远是 TODO,手工挂载环节无法自动化。
      // 现在先从 hook.config.json 读取,fail-open 退回原默认值。
      const hookHints = readHookConfigHints(srcCfg)
      const matcherIsTodo =
        hookHints.suggestedMatcher === 'TODO-reviewer-fill-matcher'
      const hintText = matcherIsTodo
        ? 'Open settings.json → hooks.PreToolUse (or the event chosen in hook.config.json) → add entry with type="command" and command="<commandPath>". Matcher pattern comes from reviewer.'
        : `Hook matcher '${hookHints.suggestedMatcher}' already derived from tool-failure mining. Run \`/evolve-install-hook ${manifest.id}\` to merge into settings.json automatically.`
      try {
        appendJsonLine(getPendingHooksPath(), {
          action: 'install',
          organismId: manifest.id,
          name,
          suggestedEvent: hookHints.suggestedEvent,
          suggestedMatcher: hookHints.suggestedMatcher,
          commandPath: dstSh,
          rationale: manifest.rationale,
          at: new Date().toISOString(),
          hint: hintText,
        })
      } catch (e) {
        warnings.push(`pending-hooks append failed: ${(e as Error).message}`)
      }

      logForDebugging(
        `[autoEvolve:installer] hook staged: ${dstSh} + pending-hooks entry`,
      )
      return {
        kind,
        installed: true,
        reason: `hook copied to ${dstSh} and queued into pending-hooks.ndjson for settings.json install`,
        artifacts,
        warnings,
      }
    }

    default: {
      const exhaustive: never = kind
      void exhaustive
      return {
        kind,
        installed: false,
        reason: `unknown kind`,
        artifacts: [],
        warnings: [],
      }
    }
  }
}

/**
 * 从 stable 走向 archived/vetoed 时的反安装。
 *
 * 调用点:arenaController.promoteOrganism 检测 fromStatus==='stable' &&
 * toStatus ∈ {'archived','vetoed'}。
 */
export function uninstallKindFromClaudeDirs(
  manifest: OrganismManifest,
): UninstallResult {
  const kind = manifest.kind
  const name = manifest.name

  switch (kind) {
    case 'skill':
    case 'prompt':
      return {
        kind,
        cleaned: false,
        reason:
          kind === 'skill'
            ? 'skill loader dir stays registered; individual organism becomes invisible via its new status dir'
            : 'prompt was never installed',
        artifacts: [],
        warnings: [],
      }

    case 'command':
    case 'agent': {
      const warnings: string[] = []
      const installDir =
        kind === 'command'
          ? getClaudeCommandsInstallDir()
          : getClaudeAgentsInstallDir()
      const dstAbs = resolve(join(installDir, `${name}.md`))

      let stat: ReturnType<typeof lstatSync> | null = null
      try {
        stat = lstatSync(dstAbs)
      } catch {
        stat = null
      }
      if (stat === null) {
        return {
          kind,
          cleaned: false,
          reason: `${dstAbs} not present, nothing to remove`,
          artifacts: [],
          warnings,
        }
      }
      if (!stat.isSymbolicLink()) {
        // 用户自己放的同名文件,不动
        warnings.push(
          `${dstAbs} exists as non-symlink, refusing to delete (not ours)`,
        )
        return {
          kind,
          cleaned: false,
          reason: `${dstAbs} is a user-owned file, left in place`,
          artifacts: [],
          warnings,
        }
      }
      try {
        unlinkSync(dstAbs)
        logForDebugging(
          `[autoEvolve:installer] ${kind} symlink removed: ${dstAbs}`,
        )
        return {
          kind,
          cleaned: true,
          reason: `${kind} symlink at ${dstAbs} removed`,
          artifacts: [dstAbs],
          warnings,
        }
      } catch (e) {
        warnings.push(`unlink ${dstAbs} failed: ${(e as Error).message}`)
        return {
          kind,
          cleaned: false,
          reason: `unlink failed: ${(e as Error).message}`,
          artifacts: [],
          warnings,
        }
      }
    }

    case 'hook': {
      const warnings: string[] = []
      const artifacts: string[] = []
      const idDir = join(getInstalledHooksDir(), manifest.id)
      const dstSh = resolve(join(idDir, 'hook.sh'))

      if (existsSync(idDir)) {
        try {
          // rm -rf 等价:recursive + force;只动 autoEvolve/installed-hooks/<id>/ 自家目录
          rmSync(idDir, { recursive: true, force: true })
          artifacts.push(idDir)
          logForDebugging(
            `[autoEvolve:installer] hook install dir removed: ${idDir}`,
          )
        } catch (e) {
          warnings.push(`rm ${idDir} failed: ${(e as Error).message}`)
        }
      }

      // 即使 rm 失败也写一条 uninstall 事件,保证审计链完整
      try {
        appendJsonLine(getPendingHooksPath(), {
          action: 'uninstall',
          organismId: manifest.id,
          name,
          commandPath: dstSh,
          at: new Date().toISOString(),
          hint:
            'Remove the matching entry (command="<commandPath>") from settings.json hooks.<event>.',
        })
      } catch (e) {
        warnings.push(`pending-hooks append failed: ${(e as Error).message}`)
      }

      return {
        kind,
        cleaned: artifacts.length > 0,
        reason:
          artifacts.length > 0
            ? `hook install dir removed + uninstall event queued`
            : `hook already absent; uninstall event queued`,
        artifacts,
        warnings,
      }
    }

    default: {
      const exhaustive: never = kind
      void exhaustive
      return {
        kind,
        cleaned: false,
        reason: 'unknown kind',
        artifacts: [],
        warnings: [],
      }
    }
  }
}

// ── Phase 16:preview(dry-run)─────────────────────────────────
//
// 设计:
//   复用 symlinkSafe 的 lstat 判定逻辑,但不调用 symlinkSync / copyFileSync /
//   appendJsonLine / mkdirSync,只做只读 stat 检查 + 计算预期路径。
//   返回与真实 install/uninstall 相同形状的 {Install,Uninstall}Result,
//   但 installed/cleaned 永远是 false,reason 前缀 "(preview)" 让调用方
//   看一眼就知道没真干事。
//
// 调用点:
//   /evolve-accept --dry-run 想要在晋升前告诉用户"如果真推 stable,下面
//   这几样东西会发生",又不能真的写磁盘。ensureDir 也不跑,避免在 preview
//   中产生空目录(例如刚 fresh install 的仓库里 installed-hooks/ 不应该被
//   提前创建)。

/**
 * 只读版 symlink 冲突判定 —— 与 symlinkSafe 共用 lstat 决策树,但绝不写。
 * 调用方可以用 outcome 反推"真 install 会走哪条分支"。
 */
function peekSymlink(
  srcAbs: string,
  dstAbs: string,
): { outcome: SymlinkOutcome; detail?: string } {
  let stat: ReturnType<typeof lstatSync> | null = null
  try {
    stat = lstatSync(dstAbs)
  } catch {
    stat = null
  }
  if (stat === null) {
    // dst 不存在 → 真 install 会 symlinkSync 成功(假设 fs 正常)
    return { outcome: 'created' }
  }
  if (stat.isSymbolicLink()) {
    try {
      const target = readlinkSync(dstAbs)
      const targetAbs = resolve(dstAbs, '..', target)
      if (targetAbs === srcAbs) return { outcome: 'existed-correct' }
      return {
        outcome: 'skip-other-symlink',
        detail: `symlink points to ${targetAbs}, not ${srcAbs}`,
      }
    } catch (e) {
      return { outcome: 'error', detail: (e as Error).message }
    }
  }
  return { outcome: 'skip-user-file', detail: 'dst exists as non-symlink' }
}

/**
 * previewInstallKindIntoClaudeDirs —— 纯读,dry-run 预测 installKindIntoClaudeDirs
 * 的效果。artifacts 表示"如果真执行,会创建/拷贝的路径";warnings 表示
 * "当前状态下真 install 会跳过/失败的警告"。
 */
export function previewInstallKindIntoClaudeDirs(
  manifest: OrganismManifest,
  orgDir: string,
): InstallResult {
  const kind = manifest.kind
  const name = manifest.name

  switch (kind) {
    case 'skill':
      return {
        kind,
        installed: false,
        reason: '(preview) skill handled by registerStableGenomeAsSkillDir',
        artifacts: [],
        warnings: [],
      }
    case 'prompt':
      return {
        kind,
        installed: false,
        reason: '(preview) prompt is reference-only, no loader install',
        artifacts: [],
        warnings: [],
      }
    case 'command':
    case 'agent': {
      const warnings: string[] = []
      const srcAbs = resolve(join(orgDir, `${name}.md`))
      const installDir =
        kind === 'command'
          ? getClaudeCommandsInstallDir()
          : getClaudeAgentsInstallDir()
      const dstAbs = resolve(join(installDir, `${name}.md`))
      if (!existsSync(srcAbs)) {
        return {
          kind,
          installed: false,
          reason: `(preview) ${kind} body missing at ${srcAbs}`,
          artifacts: [],
          warnings: [`source ${srcAbs} not found`],
        }
      }
      const { outcome, detail } = peekSymlink(srcAbs, dstAbs)
      if (outcome === 'created') {
        // 真执行会新建 symlink
        return {
          kind,
          installed: false,
          reason: `(preview) would symlink ${dstAbs} → ${srcAbs}`,
          artifacts: [dstAbs],
          warnings,
        }
      }
      if (outcome === 'existed-correct') {
        return {
          kind,
          installed: false,
          reason: `(preview) symlink already present at ${dstAbs} (would be idempotent no-op)`,
          artifacts: [dstAbs],
          warnings,
        }
      }
      warnings.push(`symlink ${dstAbs}: ${outcome} (${detail ?? ''})`)
      return {
        kind,
        installed: false,
        reason: `(preview) ${kind} install would skip: ${outcome}`,
        artifacts: [],
        warnings,
      }
    }
    case 'hook': {
      const warnings: string[] = []
      const srcSh = resolve(join(orgDir, 'hook.sh'))
      if (!existsSync(srcSh)) {
        return {
          kind,
          installed: false,
          reason: `(preview) hook.sh missing at ${srcSh}`,
          artifacts: [],
          warnings: [`source ${srcSh} not found`],
        }
      }
      const idDir = join(getInstalledHooksDir(), manifest.id)
      const dstSh = resolve(join(idDir, 'hook.sh'))
      const artifacts: string[] = [dstSh]
      const srcCfg = resolve(join(orgDir, 'hook.config.json'))
      const dstCfg = resolve(join(idDir, 'hook.config.json'))
      if (existsSync(srcCfg)) artifacts.push(dstCfg)
      return {
        kind,
        installed: false,
        reason:
          `(preview) would copy hook.sh → ${dstSh} (chmod 0755)` +
          ` and append install event to pending-hooks.ndjson`,
        artifacts,
        warnings,
      }
    }
    default: {
      const exhaustive: never = kind
      void exhaustive
      return {
        kind,
        installed: false,
        reason: '(preview) unknown kind',
        artifacts: [],
        warnings: [],
      }
    }
  }
}

/**
 * previewUninstallKindFromClaudeDirs —— 纯读,dry-run 预测
 * uninstallKindFromClaudeDirs 的效果。artifacts 表示"如果真执行会删除的路径"。
 */
export function previewUninstallKindFromClaudeDirs(
  manifest: OrganismManifest,
): UninstallResult {
  const kind = manifest.kind
  const name = manifest.name

  switch (kind) {
    case 'skill':
    case 'prompt':
      return {
        kind,
        cleaned: false,
        reason:
          kind === 'skill'
            ? '(preview) skill loader dir stays registered (no-op)'
            : '(preview) prompt was never installed (no-op)',
        artifacts: [],
        warnings: [],
      }
    case 'command':
    case 'agent': {
      const warnings: string[] = []
      const installDir =
        kind === 'command'
          ? getClaudeCommandsInstallDir()
          : getClaudeAgentsInstallDir()
      const dstAbs = resolve(join(installDir, `${name}.md`))
      let stat: ReturnType<typeof lstatSync> | null = null
      try {
        stat = lstatSync(dstAbs)
      } catch {
        stat = null
      }
      if (stat === null) {
        return {
          kind,
          cleaned: false,
          reason: `(preview) ${dstAbs} not present, nothing to remove`,
          artifacts: [],
          warnings,
        }
      }
      if (!stat.isSymbolicLink()) {
        warnings.push(
          `${dstAbs} exists as non-symlink, would be refused (not ours)`,
        )
        return {
          kind,
          cleaned: false,
          reason: `(preview) ${dstAbs} is user-owned, would be left in place`,
          artifacts: [],
          warnings,
        }
      }
      return {
        kind,
        cleaned: false,
        reason: `(preview) would unlink ${kind} symlink at ${dstAbs}`,
        artifacts: [dstAbs],
        warnings,
      }
    }
    case 'hook': {
      const warnings: string[] = []
      const artifacts: string[] = []
      const idDir = join(getInstalledHooksDir(), manifest.id)
      if (existsSync(idDir)) artifacts.push(idDir)
      return {
        kind,
        cleaned: false,
        reason:
          artifacts.length > 0
            ? `(preview) would rm -rf ${idDir} + queue uninstall event`
            : `(preview) hook install dir already absent; would still queue uninstall event`,
        artifacts,
        warnings,
      }
    }
    default: {
      const exhaustive: never = kind
      void exhaustive
      return {
        kind,
        cleaned: false,
        reason: '(preview) unknown kind',
        artifacts: [],
        warnings: [],
      }
    }
  }
}
