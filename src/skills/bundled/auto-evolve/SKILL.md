---
description: How the autoEvolve(v1.0) kernel turns feedback memories + dream signals into shadow organisms (skills/hooks/agents) that evolve under a multi-dim Fitness Oracle, with a signed promotion FSM. Stable organisms are auto-registered into the Claude Code skill loader and every invocation auto-bumps their attribution counter via a getPromptForCommand wrapper. DreamEvidence auto-feeds the Oracle via a read-only observer. An auto-promotion engine evaluates invocation-count + age thresholds per tier and can apply signed auto-oracle transitions when CLAUDE_EVOLVE=on. Phase 7 adds per-organism Oracle aggregation — every stable invocation also records a (sessionId, organismId) link, and session-level FitnessScores are reverse-attributed into manifest.fitness (W/L/N/avg), feeding both the /evolve-status panel and the auto-promotion decision (adverse veto + favorable age relax). Phase 8 adds auto-age archival — shadow/proposal organisms past their expiresAt are transitioned to archived via the same signed promoteOrganism path (trigger='auto-age'), previewed in /evolve-status and applied via /evolve-tick --apply. Phase 9 closes the runtime loop — refreshAllOrganismFitness auto-runs at /evolve-status entry and before applyAutoPromotions so panel/decide always see fresh aggregates, and promoteOrganism re-stamps expiresAt on canary (now + CANARY_TTL_DAYS) / stable (null, immune to auto-age) so promoted candidates get a fair fresh observation window instead of inheriting residual shadow TTL. Phase 10 adds stale-stable harvesting — autoArchiveEngine gains a second scan path that flags `stable` organisms whose lastInvokedAt is older than STALE_STABLE_UNUSED_DAYS (guarded by STALE_STABLE_MIN_AGE_DAYS grace) and routes them through the same promoteOrganism pipeline with a new trigger='auto-stale', keeping stable.expiresAt=null immune to auto-age while still letting unused skills decay. Phase 11 adds archiveRetrospective — a read-only summarizer over promotions.ndjson that groups transitions in a rolling window (default 30d) by trigger (manual-accept/manual-veto/auto-oracle/auto-age/auto-stale) and by (from→to) edge, exposed in the /evolve-status panel so humans can see whether Phase 8/10 thresholds are producing sensible archival rates without tailing raw ndjson. Phase 12 adds ndjsonLedger — a generic append+rotate utility shared by all three ledgers (promotions.ndjson / fitness.ndjson / session-organisms.ndjson). When a main ledger exceeds MAX_LEDGER_BYTES (10MB default) the next appendJsonLine call rotates the file (.N → .N+1, oldest dropped, main → .1, new empty main), so the three hot writers grow with bounded disk footprint. Rotation is best-effort: any failure silently degrades to plain append, so the write path never fails because rotation failed. Phase 16 closes the human-in-the-loop gap for `/evolve-accept` — before committing a promotion the reviewer can now preview FSM validity and Phase 14 side effects without writing anything (`--dry-run`), and after a real stable promotion of a hook kind the paste-ready `settings.json` snippet is surfaced inline (no more switching to `/evolve-status`). Two new preview helpers `previewInstallKindIntoClaudeDirs` / `previewUninstallKindFromClaudeDirs` share `kindInstaller`'s lstat decision logic via a private `peekSymlink` so dry-run output matches real install behavior (idempotent / skip-user-file / skip-other-symlink / would-create). Preview is strictly read-only: `ensureDir` is skipped, no `symlinkSync` / `copyFileSync` / `appendJsonLine` calls happen — even `installed-hooks/` directory creation is deferred to the real install, so a dry-run on a fresh machine leaves zero filesystem residue. The `/evolve-accept` command also runs `isTransitionAllowed` before any disk work in both dry-run and real mode, so illegal transitions surface the same "rejected by FSM" message up-front in both paths. Phase 17 extends the same dry-run pattern to `/evolve-veto` — a `--dry-run` flag surfaces the FSM pre-check, a Phase 14 uninstall preview (defensive, unreachable today because the FSM forbids stable→vetoed but kept wired for future relaxation), and a `vetoed-ids.json` diff preview showing the `+ memory.md` lines Pattern Miner will newly skip. Dry-run is strictly read-only: no `vetoOrganismWithReason`, no `markFeedbackVetoed`, no directory move — `vetoed-ids.json` is never created on a pure dry-run and the organism stays in its current status dir. Phase 18 closes the manual-recycle gap: `/evolve-archive` covers `proposal/shadow/canary/stable → archived` with a new `manual-archive` trigger, and since the FSM *does* allow `stable → archived`, this is the first real caller that actually reaches Phase 17's `renderUninstallPreview` body — stable hook/command/agent archival triggers Phase 14 uninstall automatically, pulling symlinks + `installed-hooks/<id>/` + appending an `uninstall` event to `pending-hooks.ndjson`. Critically, archive does NOT touch `vetoed-ids.json` — this is the semantic distinction from veto: archive means "retire this instance", not "blacklist the source memories", so Pattern Miner can still re-mine the same feedback when conditions change. Phase 19 completes the dry-run trifecta: `/evolve-tick` (the auto path — auto-oracle / auto-age / auto-stale) now also renders a "Phase 14 Side Effects Preview" when `dryRun=true`, filtering `applyAutoPromotions` decisions for `→stable` (install preview) and `applyAutoArchive` decisions for `stable→` (uninstall preview), so operators see the exact loader artifacts the next `--apply` would install/remove BEFORE committing. Implemented purely at render time via `readOrganism(from, id)` — `applyAutoPromotions`/`applyAutoArchive` signatures unchanged. Preview skipped under `--apply && CLAUDE_EVOLVE=on` because the side effects have already fired by then. Phase 20 closes the last mile of hook adoption: `/evolve-install-hook <id> [--dry-run] [--remove] [reason...]` semi-automates the only step the loader deliberately cannot do — merging a `pending-hooks.ndjson` install event into `~/.claude/settings.json.hooks`. Writes go through `updateSettingsForSource('userSettings', ...)` (atomic + cache-invalidating), and the command is idempotent (exact-match on `(event, matcher, command)` → `already-present`) so re-runs never duplicate entries. **Reverse-uninstall authority is an autoEvolve-owned `installed-settings.ndjson` audit ledger**, NOT settings.json — so no sentinel pollutes the merged hook entry, and `--remove` on a reviewer-renamed command reports `hand-modified` instead of guessing wrong. The real path surgically preserves any user-written hook entries in the same event/matcher and cleans up empty matchers/events on remove. Phase 21 closes the archive-to-settings orphan loop: `/evolve-archive <id> --purge-settings` chains `removeHookFromSettings(id)` **after** a successful stable→archived, so the settings.json entry is cleaned alongside Phase 14's `installed-hooks/<id>/` + `pending-hooks.ndjson` uninstall. The flag is OFF by default (Phase 18's original semantics untouched), only activates when `kind=hook && fromStatus=stable` (other combinations print a no-op rationale), and settings removal failures do NOT roll back the already-committed archive (same "real effect trumps audit" discipline as Phase 14). Hand-modified detection from Phase 20 propagates through: the chain refuses to delete a reviewer-renamed command and surfaces a warning. Phase 22 adds `oracle/goodhartGuard.ts` as an anti-cheat safety net in front of the auto-promotion decision: four independent rules (`trivial-body` when a non-prompt organism's body has <64 non-whitespace chars, `flat-dimensions` when ≥80% of contributing FitnessScores have 4-way-equal dims across ≥5 trials, `sudden-jump` when ≥6 contributing scores split half-and-half as ≤0 → ≥0.8 across time, `perfect-record` when trials≥10 + losses=0 + avg≥0.95). `detectCheating(manifest, status)` is called from `autoPromotionEngine.decide()` AFTER the global oracle gate but BEFORE `per_org_adverse` — because `wins/losses` statistics themselves can be corrupted by a cheater, so Goodhart must run first. Verdicts surface via `PromotionDecision.metrics.goodhartReasons[]` and as a `hold` action whose `reason` is `goodhart_veto: <rules> [bodyBytes=… trials=… avg=…]`. Every veto appends an auditable line to `oracle/goodhart.ndjson` (Phase 12 rotation); `recentGoodhartVetoes(limit)` is exposed for future `/evolve-status` diagnostics. Manual `/evolve-accept` deliberately bypasses the guard — reviewer judgment outweighs machine pattern-matching. Override hooks (`scoresOverride / bodyBytesOverride / aggregateOverride / skipAudit`) make the function a pure-testable unit. Phase 23 wires two new reviewer-facing panels into `/evolve-status`: **Installed Settings Snapshot** uses `listCurrentlyMergedTargets()` + `detectSettingsDrift()` (both newly exported from `settingsHookInstaller`) to list every hook currently merged into `~/.claude/settings.json` via autoEvolve, separating intact entries from `hand-modified` ones where the reviewer renamed/removed the command directly — giving a second drift view orthogonal to the Phase 15 ledger↔dir check (this one is ledger↔settings.json, Phase 15 is ledger↔installed-hooks/); **Recent Goodhart Vetoes** tails `goodhart.ndjson` in reverse-chronological order with per-veto metrics + a `rule frequency` aggregate so reviewers instantly see which of R1-R4 is firing most, pairing with `/evolve-accept` to bypass and `/evolve-veto` to harden. Paths section now also prints the absolute locations of `installed-settings.ndjson` and `goodhart.ndjson` for direct inspection. Phase 24 replaces the four hardcoded decision thresholds (`ORACLE_ADVERSE_AVG_THRESHOLD=-0.5`, `ORGANISM_WIN_THRESHOLD=0.3`, `ORGANISM_LOSS_THRESHOLD=-0.3`, `PERFECT_AVG_MIN=0.95`) with a JSON snapshot at `oracle/tuned-thresholds.json` read through `loadTunedThresholds()` (mtime-cached). `computeTuningSuggestion(windowDays=30)` walks the recent `fitness.ndjson` window and derives percentile-based recommendations (p10 for global adverse gate, positive/negative medians for win/loss buckets clamped to safe ranges, max(positive p99, 0.9) clamped to [0.9,0.99] for the goodhart R4 near-perfect bar). Below `MIN_SAMPLES_FOR_TUNE=10` data points it auto-degrades — every row keeps `current`, `insufficientReason` is populated, and `/evolve-tune --apply` refuses to overwrite the existing snapshot so low-data environments never get clobbered. `/evolve-tune` is the reviewer entrypoint: default dry-run prints an aligned `current / suggested / delta` table plus each row's rationale (zero writes); `--apply` persists the suggestion and invalidates the tuner's mtime cache so `autoPromotionEngine` / `oracleAggregator.bucketScore` / `goodhartGuard.R4` pick up the new values on their next call without a service restart; `--reset` deletes the file and falls back to `DEFAULT_TUNED_THRESHOLDS` (= previous hardcoded values); `--window N` narrows the history window (1..365). Exported constants stay as compat defaults and out-of-tree importers keep working unchanged. Phase 25 replaces the Phase 1 `spawnOrganismWorktree` stub with real `git worktree add` isolation: each organism gets its own worktree at `<CLAUDE_CONFIG_DIR>/autoEvolve/arena/worktrees/<id>/` on a dedicated `autoevolve/organism-<id>` branch forked from `HEAD`, so sessions running inside that worktree can be attributed directly (future Phase 26 work) instead of reverse-looked-up via `session-organisms.ndjson`. The real path is still gated behind `CLAUDE_EVOLVE_ARENA=on` — default off, stub-safe; `spawnOrganismWorktree(id)` now returns `{attempted, success, reason, worktreePath?, branch?}` and handles (a) fresh spawn, (b) idempotent re-spawn when the worktree is already registered with git (path + `git worktree list --porcelain` both match after `realpathSync` to defeat macOS `/tmp` → `/private/tmp` symlink mismatch), (c) branch-reuse when a leftover `autoevolve/organism-<id>` branch exists from a prior cleanup that only removed the worktree, (d) refuse-to-overwrite when the target directory exists but isn't a registered worktree (so reviewer-placed files never get nuked), (e) graceful degradation when `cwd` isn't a git repo or git is missing — reason surfaces the git stderr, no throw. Companion `cleanupOrganismWorktree(id)` does `git worktree remove --force` then best-effort `git branch -D autoevolve/organism-<id>` then a residual `rmSync` tri-stage, all wrapped so branch-delete failure doesn't flip `success` to false when the worktree itself is gone. Phase 26 closes the session-to-organism reverse-attribution gap opened by Phase 7: `spawnOrganismWorktree` now writes a `.autoevolve-organism` marker at the worktree root (single-line plain text = organism id), `paths.readOrganismMarker(startDir)` walks up from any cwd (≤32 levels, cross-filesystem safe), `FitnessInput` + `FitnessScore` gain an optional `organismId` field, `scoreSubject` propagates it when present (conditional spread — old scores without the field stay undefined), `observeDreamEvidence` calls `readOrganismMarker(process.cwd())` at Dream converge time and injects the id transparently, and `oracleAggregator.aggregateOrganismFitness` / `aggregateAllOrganisms` now union "direct-attribution (score.organismId === id)" ∪ "Phase 7 reverse lookup (session→organism link)" — the Phase 7 early-exits on empty `sessionSet` were removed so direct-only organisms still aggregate; per-score Set de-dup prevents double-counting when both paths hit. Phase 27 replaces the hardcoded 4-dim Oracle weights (0.4/0.3/0.15/0.1 for userSatisfaction/taskSuccess/codeQuality/performance) with an SNR-based meta-evolver: `oracle/metaEvolver.ts` computes per-dimension signal-to-noise ratio `|mean(win) - mean(loss)| / (std(all)+ε)` over a rolling fitness window (default 30d, win/loss buckets use the Phase 24 tuned thresholds for alignment with `oracleAggregator.bucketScore`), normalizes proportional to SNR, clamps each dimension to `[WEIGHT_MIN=0.05, WEIGHT_MAX=0.7]` (prevents both monopoly and starvation), and re-normalizes. Results land in `oracle/tuned-oracle-weights.json` (mtime-cached, field-level default fallback) which `loadOracleWeights()` now reads first — a 3-layer priority (tuned → base `weights.json` → `DEFAULT_ORACLE_WEIGHTS`) means user-edited `weights.json` is never silently overwritten and `--reset` is a single `unlink`. The safety dimension is deliberately excluded: it is a veto switch, not a weight, and `safetyVetoEnabled` always flows through from the base layer. Below `MIN_SAMPLES_FOR_META=20` data points the suggestion auto-degrades (every row keeps current, `insufficientReason` populated, `/evolve-meta --apply` refuses to overwrite). `/evolve-meta [--window DAYS] [--apply] [--reset]` is the hidden reviewer entry: default dry-run prints an aligned `current/suggested/delta/SNR` table with per-row rationale (`SNR≈0: floor`, `low: shrink`, `moderate: standard`, `high: boost`), no writes; `--apply` persists + invalidates the cache so `scoreSubject` picks up new weights on next call without a service restart; `--reset` deletes only the tuned snapshot. Phase 28 adds Oracle-level anti-Goodhart: user-curated canonical benchmark tasks live in `oracle/benchmarks.json` (mtime-cached, field-level sanitize, id regex `/^[A-Za-z0-9_-]{1,64}$/`, id-collision preserves original `createdAt`), per-weightsVersion runs append to `oracle/benchmark-runs.ndjson` (Phase 12 rotation) with SHA-256 `signature` + auto-generated `runId` + auto-snapshotted `oracleWeightsVersion` (via `loadOracleWeights().version` at record time — freezing the Oracle snapshot that produced the score). `computeDrift({windowRuns=500, driftThreshold=0.3, minSuspiciousBenchmarks=3})` walks pairwise `(versionA, versionB)` buckets per benchmarkId, computes `|meanA - meanB|`, and flags `suspicious=true` only when **≥3 distinct benchmarks simultaneously drift >0.3** — single-benchmark heavy drift never triggers the gate, mitigating false positives from noisy individual scores. `/evolve-bench --list|--add|--record|--drift` is the hidden reviewer entry: `--add <id> --desc "..." [--criteria "..."]` registers a benchmark, `--record --id <benchmarkId> --score <n> [--organism <id>] [--weights-version <str>]` records a human-scored run (rejects unknown ids with remediation hint), `--drift [--threshold N] [--min-benchmarks N] [--window N]` prints the aligned cross-version report with per-pair Δ + `susp?` column, `--list` dumps all registered benchmarks. `/evolve-meta --apply` now soft-gates on drift: when `computeDrift().suspicious===true`, the apply is refused unless the reviewer re-runs with `--force`; the refusal message links back to `/evolve-bench --drift` for inspection. The soft-gate is non-blocking for new installs (insufficient data → `suspicious=false`), backwards-compatible (benchmark ledger unreachable → silent skip), and the `--force` override writes a diagnostic line to the apply output explaining the override. `benchmark-runs.ndjson` is deliberately decoupled from `fitness.ndjson` — separate path, separate reader — to prevent `oracleAggregator` / `autoPromotionEngine` / `goodhartGuard` from accidentally treating reviewer benchmark scores as organism fitness samples. Phase 29 closes the Phase 28 cold-start problem: `mineBenchmarkCandidates({windowLines=2000, topK=10, minSamples=2, minDelta=0.3, minExtremity=0.5, excludeRegistered=true})` inline-scans the tail of `fitness.ndjson` (bypassing Phase 26 `recentFitnessScores(limit=20)` which is too small to mine), groups by `subjectId`, builds per-Oracle-version buckets, and rank-filters by `informativeness = 0.5·min(maxVersionDelta,1) + 0.3·|meanScore| + 0.2·min(log10(n+1)/2, 1)` — an OR gate on (Δ≥minDelta) or (extremity≥minExtremity) retains both weight-sensitive multi-version subjects and single-version decisive winners/losers. Suggestions are emitted with `suggestedId = "mined-" + slugified(subjectId).slice(0,48)` (id-safe regex-only chars, distinct `mined-` namespace so they never collide with handwritten benchmark ids), a human-readable `rationale` line packing all three signals, and an `oracleVersions` list so the reviewer can see which versions scored divergently. This is the single deliberate exception to the Phase 28 path-isolation rule (the miner is the only code path that reads `fitness.ndjson` from benchmarkLedger.ts), documented in the header comment and kept read-only: no writes to `benchmarks.json`, `benchmark-runs.ndjson`, or `fitness.ndjson`; the reviewer still runs `/evolve-bench --add <suggestedId>` to register a candidate, so mining stays non-authoritative. `/evolve-bench --mine [--top N] [--window N] [--min-delta N] [--min-extremity N] [--include-registered]` is the hidden reviewer entry — prints a ranked `# / suggested-id / info / Δver / mean / n / rationale` table plus a mapping footer `suggestedId ← subjectId=... organismId=...` for trace-back, and `--include-registered` (default off) restores already-registered ids when the reviewer wants to audit their current canonical set. `--window` is shared with `--drift` (same "how many lines to look back" semantic, same ParsedFlags.driftWindow field). Phase 30 closes the Phase 25 single-arena bottleneck so a proposal batch can spawn multiple isolated git worktrees at once — `arenaController.spawnOrganismWorktreesBatch(ids, {maxParallel})` returns per-id `{attempted, success, reason, worktreePath?, branch?}` entries, `cleanupOrganismWorktreesBatch(ids)` mirrors the cleanup path, and `listActiveArenaWorktrees()` scans `arena/worktrees/<id>/` for `{id, worktreePath, markerExists}` with stable id-sorted output. `MAX_PARALLEL_ARENAS=8` is a hard cap on concurrently-live worktrees — the batch function projects `active_before + new_ids` against `min(--max-parallel, MAX_PARALLEL_ARENAS)` and refuses the **entire** request (entries=[], `capHit={activeBefore,requested,cap}`) if the projection exceeds the ceiling; half-spawning would leave callers guessing which ids made it and risks resource leaks. Internally the function still calls the existing `spawnOrganismWorktree` serially so git's `index.lock` stays uncontested — the "parallel" in Phase 30 refers to post-spawn concurrent worktree **availability** (downstream consumers can now run shadow/canary tests in parallel against multiple arena/worktrees/ dirs), not concurrent git invocations. Input sanitization: empty / whitespace-only ids skipped, duplicates collapsed to first-seen order; single-id failures don't contaminate siblings. `listActiveArenaWorktrees()` is deliberately read-only and works even when `CLAUDE_EVOLVE_ARENA` is off so reviewers can audit residue without flipping the flag; `markerExists=false` surfaces stale dirs (crashed spawn, manual `rm` with marker retained). `/evolve-arena <--list | --spawn ids... [--max-parallel N] | --cleanup ids... | --cleanup-all>` is the hidden reviewer entry — `--list` always read-only, write modes gated on `CLAUDE_EVOLVE_ARENA=on`, `--cleanup-all` forwards every id from `listActiveArenaWorktrees()` to `cleanupOrganismWorktreesBatch` for one-shot teardown. Output shape: aligned `id / marker / worktreePath` table with stale-residue footer for `--list`; per-entry `✓/✗` badge + `worktreePath` (or reason) + optional `branch:` line for `--spawn`; parallel badged rows for `--cleanup` / `--cleanup-all`. Phase 31 closes the "每个 organism 从零起步" blind spot: `services/autoEvolve/arena/kinshipIndex.ts` exports `findKinStableOrganisms(proposalText, {topK?, minSimilarity?, includeManifestBody?})` + `suggestSeedBody(proposalText, opts?)` using token-level Jaccard similarity (EN + CJK stop-word filtering, char-level CJK splitting) over every stable organism's `manifest.name + rationale + winCondition` (+ primary body when includeManifestBody=true), returning topK matches sorted descending with `rationalePreview` / `bodyPreview` / `bodyPath` attached. `suggestSeedBody` picks top1 kin and prefixes its primary body with `<!-- kin-seeded from stableId=X similarity=Y source=FILENAME -->` for audit; empty stable/, sub-threshold kin, or body-less top kin returns `{seedBody:'', strategy:'empty', reason}` so callers fall back to a blank template (deliberately **not** falling back to proposalText, which would pollute SKILL.md with meta description). Defaults `topK=5` (clamped [1,50]), `minSimilarity=0.1` (empirically tuned — 0.2 turned out too strict against realistic body sizes), `includeManifestBody=true`. Module is read-only (never writes stable/, never touches ledgers) and independent of `CLAUDE_EVOLVE_ARENA`. `/evolve-kin <--match "<text>" | --seed "<text>"> [--top N] [--min-sim F] [--no-body]` is the hidden reviewer entry, printing an aligned `# / stableId / sim / name` table with rationale/body previews for --match, and `strategy / reason / chosen / bodyPath` metadata + `--- BEGIN/END seedBody ---` markers for --seed. Phase 32 把 Phase 31 的 kinshipIndex 默认接进 emergence 管线:`skillCompiler.compileCandidate` 现在在渲染 primary body 之前自动调 `findKinStableOrganisms(candidate.name + rationale + winCondition, {topK:1})`,命中时把 top1 stable 近亲的 primary body 原样写入 `<orgDir>/kin-seed.md`(带 `<!-- kin-seeded reference stableId/similarity/source/seededAt -->` 审计头,明确写"不是 primary body"),并在 `manifest.kinSeed` 记录 `{stableId, similarity, source, seededAt}`。primary body 仍完全来自 `renderBodyForKind`,kin-seed.md 只作为下游 agent/LLM 的参考体——故意**不**把 kin body 混入 primary,避免 skill loader 把参考内容当可执行模板。`CompileOptions.kinSeed: true|false|undefined` 覆盖环境变量 `CLAUDE_EVOLVE_KIN_SEED`(默认 on;set to `off/0/false/no` 关掉),`CompileOptions.kinSeedOptions.{minSimilarity, includeManifestBody}` 透传给 kinshipIndex。失败模式全部静默降级:stable/ 空 / 无命中 / 读 kin body 失败 / 写 kin-seed.md 失败都不影响 compile 主流程,只在 logForDebugging 留痕。`manifest.kinSeed` 三态:`undefined` = 功能跑了但未命中 / 兼容旧 manifest;`null` = 被显式关闭(env 或 opts.kinSeed=false);`object` = 命中。Phase 33 给 Phase 30 的批量 worktree 加上 **breadth-first 优先级调度器**:新模块 `services/autoEvolve/arena/arenaScheduler.ts` 暴露 `scoreShadowPriority(manifest)`(纯函数,trials/stale/age/kin 四分量 ∈ [0,1],权重 0.45/0.30/0.15/0.10)、`listShadowPriority({excludeActiveWorktree?, maxShadowTrials?, topN?})` 和 `pickNextShadowIds(count, opts?)`;每个 PriorityEntry 带 components + summary(shadowTrials/lastTrialAt/ageDays/staleDays/kinSeed/name/kind)。排序降序 + tie-break 走 id 字典序保证 reproducible;excludeActiveWorktree(默认 true)通过 Phase 30 的 listActiveArenaWorktrees 剔除正在跑的 id,maxShadowTrials 让 organism 跑够后 trials 分量归零、把 slot 还给新生。`/evolve-arena` 增两个子命令:`--schedule [N]`(read-only、不依赖 CLAUDE_EVOLVE_ARENA)打印优先级表(含 prio/trials/ageDays/stale/kin badge);`--spawn-auto N [--max-parallel M]`(写入、需 flag=on)让 scheduler 挑 top-N 自动喂 spawnOrganismWorktreesBatch,语义和 --spawn 完全一致(同 cap、同 whole-hog 拒绝)。Phase 34 给 Phase 32 埋下的 `manifest.kinSeed.stableId` 配一副"看得见的眼睛":新模块 `services/autoEvolve/arena/lineageBuilder.ts` 用一次 listAllOrganisms() 扫描建出 genome **血缘森林**(`buildLineageForest` → trees[] + byId + stats),`scoreShadowPriority` 风格的纯函数 `summarizeLineage` 聚合 byStatus/kinnedNodes/kinDisabled/largestFamily,`renderLineageAscii` 把 forest 画成 ASCII 树(`├─ ` / `└─ ` / 多层缩进),每个节点挂 status/winRate/trials/ageDays,child 上带 `sim=<jaccard> src=<file>`,父找不到的 organism 标 `ORPHAN→<id>`,kinSeed 指向自己/成环的节点标 `CYCLE!` 并中断 DFS 防爆栈;children 按 id 字典序稳定,同一仓库状态下两次调用输出完全一致。新命令 `/evolve-lineage`(读-only,不吃任何 feature flag)三个互斥 mode:`--tree [root-id] [--max-depth N] [--no-kin]` 打印整棵 forest 或子树,`--max-depth` 超限后给 "subtree(s) hidden" 折叠提示;`--stats` 列聚合计数和最大家族;`--json [root-id]` 吐机器可读 JSON(children 递归嵌套、cycle/orphan flag 照留)。Phase 35 把 "新仓库 shadow/ 永远空" 这个冷启动痛点堵死:新模块 `services/autoEvolve/emergence/warmstartLibrary.ts` 内置一组 curated baseline pattern(review-guard / safe-rm-guard / commit-msg-guard / test-flaky-retry / memory-audit / verify-before-claim / skillify-reminder),`listBaselines() / findBaseline(slug)` 暴露只读视图,`seedWarmstart({include?, exclude?, dryRun?, force?}) → {attempted, dryRun, entries, counts}` 把每条 baseline 通过 `baselineToPatternCandidate` 转成 PatternCandidate、复用 Phase 2 skillCompiler 的正规管线生成 shadow organism(结果和 pattern miner 产的 organism 完全同构 —— manifest.fitness 从 0 起、status=shadow、可被 kin-seed / promoteOrganism),去重门走 `existsSync(getOrganismDir('shadow', orgmId))`,organism id 用和 `makeOrganismId` 完全一致的 `sha256(nameSuggestion:v1)[0..8]` 算法避免挡不住重复。`isWarmstartWriteEnabled()` env gate 优先级 `CLAUDE_EVOLVE_WARMSTART` > `CLAUDE_EVOLVE` > 默认 on;命令 `/evolve-warmstart`(两个互斥 mode):`--list [--tags tag1,tag2]` 始终只读,列所有 baseline(slug/kind/tags/pitch 表);`--seed [--include slug1,slug2] [--exclude slug3] [--dry-run] [--force]` 合成到 shadow/,`--dry-run` 绕开 gate 走"只计划不写盘",`--force` 允许 overwrite existing。Phase 36 把 Phase 24 阈值调优和 Phase 27 权重调优接成一个协调器:新模块 `services/autoEvolve/oracle/jointTuningCoordinator.ts` 暴露 `planJointTuning(windowDays?)` 一次性算出两侧建议,按 ready(insufficient 或 row |delta| 小于 MIN_EFFECTIVE_DELTA=0.01/0.02 视为噪声)和 big(单条 |delta|≥0.1/0.05 或 norm≥0.15/0.08)分类出 5 种 interaction(both-insufficient / threshold-only / weights-only / cooperative / big-shake),再映射到 5 种 ApplyStrategy。**顺序是先阈值后权重** —— 因为 `computeWeightSuggestion` 内部 `loadTunedThresholds()`,阈值换了权重 SNR 的分桶也换,旧 suggestion 就 stale 了;`applyJointTuningPlan` 写完阈值后**重算** weight suggestion,并在 big-shake 分支里对权重 delta 走 `dampFactor=0.5` damping(在当前权重基础上只走一半路到新建议,clamp 到 [WEIGHT_MIN,WEIGHT_MAX] 并 re-normalize),避免两变量同时大幅移动导致归因困难。重算后若 weight suggestion 变 insufficient(阈值变紧导致 win/loss 样本不够),actualStrategy 会降级为 thresholds-only,不会硬塞一个坏 weight。`isJointTuneWriteEnabled()` env gate 三级优先:`CLAUDE_EVOLVE_JOINT` > `CLAUDE_EVOLVE_TUNE AND CLAUDE_EVOLVE_META`(都 on)> `CLAUDE_EVOLVE` 兜底,默认 **off**(联合写 blast radius 比单边大,保守)。命令 `/evolve-tune-joint [--window N] [--apply] [--reset --confirm]`:默认 dry-run 打印阈值表 + 权重表 + plan notes(始终只读);`--apply` 在 gate on 时真写两个 tuned 文件,输出 damped trace(每维 raw → damped);`--reset --confirm` 删 `tuned-thresholds.json` + `tuned-oracle-weights.json`,回到 DEFAULT_* 常量。Phase 37 关闭 autoPromotion tier 阈值硬编码的痛点:新模块 `services/autoEvolve/emergence/promotionThresholdTuner.ts` 把原硬编码 `SHADOW_TO_CANARY_MIN_INVOCATIONS=3` / `SHADOW_TO_CANARY_MIN_AGE_DAYS=1` / `CANARY_TO_STABLE_MIN_INVOCATIONS=10` / `CANARY_TO_STABLE_MIN_AGE_DAYS=3` 抽成 `TunedPromotionThresholds` 落盘 `oracle/tuned-promotion-thresholds.json`(新 path helper `getTunedPromotionThresholdsPath`),`DEFAULT_TUNED_PROMOTION_THRESHOLDS` 与原值 1:1 相等,文件缺失即行为不变。`autoPromotionEngine.decide` 在 Phase 7 favorable 判定后插 `const tuned = loadTunedPromotionThresholds()`,用 `tuned.*` 替换 shadow→canary / canary→stable 两个分支里对原硬编码的所有引用(`export const` 保留向后兼容)。**信号**:`readAllTransitions()` 读 `oracle/promotions.ndjson` 的 Transition 流,按 `(from,to)` 分桶 `shadow→canary` / `canary→stable`,窗口内 promotion 事件的 organism 集合为分母,其中又在该 organism promotion 时间之后(`transition.at >= promotedAt` 的 ordering guard)出现 `to='vetoed'` 的 organism 为分子 → `regressionRate_tier`;只数 `vetoed` 不数 `archived`(archived 两义)。**决策**:`decideRow` 对 `regressionRate ≥ HIGH_REGRESSION_RATE=0.3` 建议 tighten +1,`≤ LOW_REGRESSION_RATE=0.05` AND `total ≥ MIN_SAMPLES_RELAX=5` 建议 relax -1,其它 hold;所有 suggested clamp 到 `[INVOCATIONS_MIN=1, INVOCATIONS_MAX=50]` / `[AGE_DAYS_MIN=0, AGE_DAYS_MAX=30]`;全局 `MIN_SAMPLES_FOR_PROMO_TUNE=5` 样本门槛下 insufficient,`rows=[]`。`loadTunedPromotionThresholds()` mtime 缓存 + schema 校验,坏文件 fallback DEFAULT 不覆盖;`saveTunedPromotionThresholds` 写后清缓存;`suggestionToNext` 保留未在 rows 出现的 tier-field。命令 `/evolve-tune-promotion [--apply|-a] [--window|-w DAYS] [--reset]`:默认 dry-run 打印 Phase 37 标题、mode/window/total、两行 `promoted/regressed/rate` 统计、对齐 Suggestion 表 + Rationale 区块(含 tighten/relax/hold 理由);`--apply` 在 insufficient 时跳过保护现有文件,否则写盘并追加 `Apply result` 区块;`--reset` `unlinkSync` + 清缓存 + `fall back to DEFAULT` 提示。**不设 env gate** —— tuner 只写单文件,保守 ±1 步长 + 夹紧 + insufficient 自守已足够。 Phase 38 关闭 autoArchive stable-unused 阈值硬编码的痛点,同时关闭 Phase 14 candidate 的剩余一半:新模块 `services/autoEvolve/emergence/archiveThresholdTuner.ts` 把 `STALE_STABLE_UNUSED_DAYS=45` / `STALE_STABLE_MIN_AGE_DAYS=14` 抽成 `TunedArchiveThresholds` 落盘 `oracle/tuned-archive-thresholds.json`(新 path helper `getTunedArchiveThresholdsPath`),`DEFAULT_TUNED_ARCHIVE_THRESHOLDS` 与原值 1:1 相等,文件缺失即行为不变。`autoArchiveEngine.decideByStale`(Phase 38 后改为 `export function`)在 age/dsli 算出后立刻 `const tuned = loadTunedArchiveThresholds()`,用 tuned 值替换原硬编码,同时 `archive` rationale 的 `threshold=Xd` 也随 tuned 值更新 —— 形成 self-calibrating 闭环:新归档事件的 dsli/threshold 比例会被下一轮 tuner 读到。**信号源(Phase 38 创新点)**:`promotionFsm.ts` 将 `archived` 设为终态(`archived → ∅`),FSM 不允许复活,所以"archived→resurrected"类信号恒为 0;转而解析 autoArchiveEngine 已经写进 Transition.rationale 的 dsli,格式 `"auto-stale: no invocation for {dsli}d (lastInvokedAt=..., threshold=Xd, age=Yd)"`,`parseDsliFromRationale` 用 `/no invocation for (\d+\.?\d*)d/` 抽数(失败 → null,跳过不污染)。**分桶**:窗口内 `trigger='auto-stale'` 事件的 dsli 按 `current.staleStableUnusedDays` 分三桶 —— borderline(`0 < dsli ≤ threshold * (1 + BORDERLINE_MARGIN=0.2)` 刚过线、阈值偏紧)、longAbandoned(`dsli ≥ threshold * LONG_ABANDON_MARGIN=2.0` 早已躺尸、阈值偏松)、healthy(中间)。**决策**:`borderlineRate ≥ HIGH_BORDERLINE_RATE=0.4` → relax(UNUSED `+UNUSED_STEP=5`, MIN_AGE `+MIN_AGE_STEP=2`);`longAbandonedRate ≥ HIGH_ABANDONED_RATE=0.6` → tighten(-5/-2);其它 hold;全部 clamp 到 `[UNUSED_DAYS_MIN=7, UNUSED_DAYS_MAX=365]` / `[MIN_AGE_DAYS_MIN=1, MIN_AGE_DAYS_MAX=90]`;`parsedCount < MIN_SAMPLES_ARCHIVE_TUNE=5` → insufficient 空 rows。步长故意比 Phase 37 的 ±1 大,因为 45d 的 ±1 小于噪声。`loadTunedArchiveThresholds()` mtime 缓存 + schema 校验 + 坏文件 fallback。命令 `/evolve-tune-archive [--apply|-a] [--window|-w DAYS] [--reset]` 与 `/evolve-tune-promotion` 同构:dry-run 打印 Phase 38 标题 + mode/window/total + `auto-stale events (in window): N  dsli-parsed: M` + borderline/longAbandoned rate 行 + Suggestion 对齐表 + Rationale 区块 + `--apply`/`--reset` 提示;`--apply` insufficient 时跳过保护现有文件,否则写盘 + `Apply result`;`--reset` `unlinkSync` + 清缓存 + `fall back to DEFAULT`。**不设 env gate** —— tuner 只写单文件,blast radius 仅限 archive 阈值。 Phase 39 关闭 oracleAggregator 聚合权重"老样本和新样本同权"的痛点 —— `aggregateOrganismFitness`/`aggregateAllOrganisms` 原本用算术平均,几个月前的 session 把 `manifest.fitness.avg` 锁死,最近 20 条全 loss 也拉不动 +0.3 均值,`autoPromotionEngine` adverse-veto 无法触发;反向也成立(一条早年 loss 持续压制刚起色的 shadow)。新模块 `services/autoEvolve/oracle/oracleDecayTuner.ts` 在 aggregator 的 sum 阶段接入 **指数半衰期衰减**:`weight(score) = 0.5^((now-scoredAt)/halfLifeDays)`、`weightedAvg = Σ(score·weight)/Σ(weight)`,抽出 `TunedOracleDecay { version:1, updatedAt, halfLifeDays }` 落盘 `oracle/tuned-oracle-decay.json`(新 path helper `getTunedOracleDecayPath`)。**向后兼容关键**(与 Phase 24/37/38 不同):Phase 24/37/38 的 DEFAULT 直接等于原硬编码生效值,文件缺失即等价于老行为;但 oracleAggregator 原本根本没有 halfLife 概念,没有"原值"可对齐。Phase 39 引入 **sentinel**:`DEFAULT_TUNED_ORACLE_DECAY.halfLifeDays = 0` 约定含义"衰减关闭,`decayWeight ≡ 1`,aggregator 退化为算术平均"。文件缺失 / 非法 schema / 用户主动 `--disable` 三种情况下 aggregator 100% 等同 Phase 1-38,零行为变更。用户 opt-in 唯一入口是 `/evolve-tune-oracle-decay --apply` 写入正值。**信号**:读 `recentFitnessScores(windowSamples=500)`,对每条算 age(跳过非法 ISO 和未来时间),取 p75 age(nearest-rank)作为"有意义样本寿命"。**决策**:`current=0` 时 first-opt-in(`p75 ≥ 14d → suggested = round_to_step(p75)` 对齐 `HALF_LIFE_STEP=15`,`p75 < 14d` hold);`current>0` 时 `ratio = p75/halfLife`:`≥ 2.0` relax +15(半衰期太短老样本过快消失),`≤ 0.3` tighten -15(半衰期太长老样本不衰减),中间 hold;clamp `[HALF_LIFE_MIN=7, HALF_LIFE_MAX=365]`。步长 15 比 Phase 37 的 ±1 大,因为 halfLife 量级本身大,±1 小于噪声。样本门槛 `MIN_SAMPLES_DECAY_TUNE=10`。**decayWeight 防守**:`halfLifeDays ≤ 0 → 1`(sentinel/非法)、坏 ISO → 1、未来时间 → 1 —— 这是 aggregator 热路径,必须无异常且不强行衰减坏数据。**aggregator 接线**:两个 aggregate 函数的累加器由 `sum` 改为 `weightedSum + weightSum`,最终 `avg = weightSum > 0 ? weightedSum/weightSum : 0`;`aggregateAllOrganisms` 中 weight **每条 score 只算一次**(不是 per-hit organism),当一条 score 通过 organismId 直接归属 + sessionSet 反查同时命中多个 organism 时共享同一份 weight,避免按命中数放大。`wins/losses/neutrals/trials` 保持整数桶不受 decay 影响(仍按整条样本 +1),下游 `autoPromotionEngine.MIN_INVOCATIONS` 对比稳定。命令 `/evolve-tune-oracle-decay [--apply|-a] [--window|-w N] [--reset] [--disable]`(`--window` 1..10000 默认 500;`--apply`/`--reset`/`--disable` 三者两两互斥):dry-run 打印 Phase 39 标题 + mode/window/actual count/current halfLifeDays(current=0 标 `(sentinel: decay OFF)`)+ `p25/p50/p75` 统计 + Suggestion 对齐表 + Rationale + 三提示;`--apply` insufficient 时跳过保护用户手改,否则写盘 + `Apply result`;**`--disable`** 是 Phase 39 独有 opt-out 路径,写入 `halfLifeDays=0` 但 **保留文件作为审计**(区分"从未触碰"和"用户主动关");**`--reset`** `unlinkSync` 回到 DEFAULT sentinel。**不设 env gate** —— sentinel 设计保证从未 `--apply` 的环境完全不受 Phase 39 影响,blast radius 极小。 Phase 40 关闭"晋升后失能黑洞":`autoPromotionEngine` 把 organism 从 shadow 推到 canary/stable 是**前向 FSM**,但真正跑到 canary/stable 之后如果 Phase 39 加权 `manifest.fitness.avg` 迅速回落,老 FSM 没有反向边,只有 `autoArchiveEngine` 在 stable "长期未调用"时才归档 —— 一个晋升失败的 canary/stable 会持续污染 aggregate、被 session 触发、拉偏 Oracle 分布直到用户手动 `/evolve-veto`。Phase 40 **给 FSM 加反向边**:`promotionFsm.ALLOWED` 表里 canary 新增 → `shadow`、stable 新增 → `shadow`,`TransitionTrigger` 枚举新增 `'auto-rollback'`。新模块 `services/autoEvolve/emergence/rollbackWatchdog.ts` 暴露 `scanRollbackCandidates()` / `applyRollback(ev)` / `evaluateRollback(manifest, aggregate, nowMs?)` / `findLastPromotionAt(id, toStatus, limit=2000)`。**降级目标是 shadow 而不是 vetoed** 的纪律:shadow 是"观察位",保留 invocationCount / fitness 累积数据;给 organism 第二次自然晋升通道(后续数据变好会重回 canary);shadow 阶段持续拉胯走既有 shadow→vetoed 路径吸收(不重复造轮子);直接 veto 损失晋升阶段样本、观察断层,不符合"保留信号"原则。**三重门槛**(任一不满足 hold):canary `avg ≤ -0.3 & trials ≥ 3 & ageSincePromotion ≥ 3d`;stable `avg ≤ -0.2 & trials ≥ 5 & ageSincePromotion ≥ 7d`。canary 阈值 -0.3 对齐 Phase 7 `ORGANISM_LOSS_THRESHOLD`(多数样本落 loss 区才降,避免中性 noise 触发);stable -0.2 更严,因为 stable 已证过自己,要更大证据强度才回退;trials 门槛让刚晋升样本稀少的 organism 不被首条低分拖垮;`MIN_AGE_DAYS` 让 organism 至少接一些新样本,不被历史均值锁死。**最近晋升时间戳**:`findLastPromotionAt` 从 `promotions.ndjson` 扫所有 `to=<status>` transition 取 `max(Date.parse(t.at))` —— 不依赖 `readRecentTransitions` 的排序方向(ledger reader 未来改排序不会打穿 watchdog);缺失则 fallback 到 `manifest.fitness.lastTrialAt`(把"最近一次 fitness 事件"当晋升时刻代理,至少保证 MIN_AGE_DAYS 不会永远漏判)。**applyRollback** 调 `promoteOrganism({fromStatus, toStatus:'shadow', trigger:'auto-rollback', rationale, oracleScoreSignature: ev.aggregate.lastScoreSignature})` —— ledger 写带 signature 的 transition,审计可回查"是哪次 fitness 打分触发的 rollback"。**与 Phase 38 archive watchdog 的分工**:Phase 38 基于"无调用"(时间信号 → stale → archived);Phase 40 基于"有调用但评分差"(fitness 信号 → rollback → shadow);两者互补,一个管"死去",一个管"活着但失能"。rollback 回 shadow 再拉胯走 shadow→vetoed(vetoed 是 ALLOWED 终态无出边),两套闸门串联收敛到终态。命令 `/evolve-rollback-check [--apply|-a] [--limit|-l N]` 位于 `commands/evolve-rollback-check/index.ts`(hidden),dry-run 打印 `## autoEvolve Promotion Rollback Watchdog (Phase 40)` 标题 + mode + scanned/decisions 计数 + 按 rollback 置顶/同类 avg 升序的 evaluation 列表 + 每条 `[DECISION] status/name (id) / avg + trials + age + thresholds / rationale`;`--apply` 逐条 `applyRollback` ✓/✗ + `applied=X failed=Y` 汇总。`--limit` 1..500 默认 20 只截断输出,scan 永远全量。**未抽 tuner**(Phase 4x 候选),v1 先观察用户误降级/漏降级反馈再决定。 Use when extending pattern mining, skill compilation, arena status transitions, fitness signals, stable-skill attribution, auto-promotion thresholds, per-organism fitness aggregation, TTL-driven archival, TTL policy on promotion, stale-stable harvesting, cross-trigger audit over ledger history, ledger size management, kind-specific body rendering, kind-specific loader install/uninstall on stable entry/exit, reviewer-facing hook-install queue surfacing, human-in-the-loop dry-run preview of promotion side effects or veto side effects, manual archival of stable organisms (including proper Phase 14 uninstall without blacklisting source memories), the auto-path variant of dry-run side-effect preview in `/evolve-tick`, semi-automatic merging of pending hooks into `~/.claude/settings.json` with autoEvolve-owned reverse-uninstall audit trail, chain-archival that also purges the settings.json entry in a single command, detection of organism-level fitness gaming (trivial bodies, flat scoring, sudden jumps, perfect records) with a pure-function + audit-ledger veto, reviewer-facing visibility into what autoEvolve has merged into settings.json (intact vs hand-modified) and what Goodhart has recently vetoed (with rule-frequency aggregation), rollback-threshold auto-tuning based on FP rate (recovery-after-rollback) and FN rate (avg-crossed-but-held-by-trials-or-age) over the rollback-watchdog signal pair, or routing a new observation into the evolutionary loop.
---

# autoEvolve Kernel (v1.0 — Phase 1+2+3+4+5+6+7+8+9+10+11+12+13+14+15+16+17+18+19+20+21+22+23+24+25+26+27+28+29+30+31+32+33+34+35+36+37+38+39+40+41)

A Darwinian evolution engine that auto-synthesizes skills / hooks / agents from
**feedback memories + dream signals**, runs them in `shadow` isolation, and
promotes/vetoes them based on a multi-dimensional Fitness Oracle.

> **Phase 1 scope**: scan feedback memories → mine patterns → compile `shadow`
> organisms → dry-run `/evolve-status`. **No auto-promotion**, no worktree spawn.
> All side effects confined to `~/.claude/autoEvolve/`.

## Map

| Layer | File | Role |
|-------|------|------|
| Types | `services/autoEvolve/types.ts` | Leaf module — OrganismManifest / PatternCandidate / FitnessScore / Learner |
| Paths | `services/autoEvolve/paths.ts` | `~/.claude/autoEvolve/` structure helpers. **Phase 41** adds `getTunedRollbackThresholdsPath()` → `<claudeBase>/autoEvolve/oracle/tuned-rollback-thresholds.json`, companion to Phase 24 `tuned-thresholds.json` / Phase 27 `tuned-oracle-weights.json` / Phase 37 `tuned-promotion-thresholds.json` / Phase 38 `tuned-archive-thresholds.json` / Phase 39 `tuned-oracle-decay.json`. |
| Feature gates | `services/autoEvolve/featureCheck.ts` | `CLAUDE_EVOLVE` (default OFF), `_SHADOW` (default ON), `_ARENA` (default OFF) |
| Learner Registry | `services/autoEvolve/index.ts` | Registry singleton; re-exports `dreamTriageLearner` from feedbackLoop |
| Pattern Miner | `services/autoEvolve/emergence/patternMiner.ts` | Memdir feedback → PatternCandidate[] (dedup via existing genome) |
| Skill Compiler | `services/autoEvolve/emergence/skillCompiler.ts` | PatternCandidate → shadow organism (manifest.json + SKILL.md) |
| Arena Controller | `services/autoEvolve/arena/arenaController.ts` | List / move / veto / archive organisms; `promoteOrganism` + `vetoOrganismWithReason` wrap FSM + ledger; `recordOrganismInvocation` bumps stable manifest counter; Phase 7 adds `refreshOrganismFitness` / `refreshAllOrganismFitness` that writes aggregator output back into `manifest.fitness` via tmp+rename; Phase 9 adds `CANARY_TTL_DAYS=60` + `restampExpiresAtOnPromote(toStatus, id)` — called inside `promoteOrganism` between ledger-write and manifest-readback to reset `expiresAt` on canary (+60d) / stable (null, immune to auto-age). **Phase 25**: `spawnOrganismWorktree(id)` / `cleanupOrganismWorktree(id)` are now real — gated by `CLAUDE_EVOLVE_ARENA=on` (stub-safe when off); spawn does `git worktree add -b autoevolve/organism-<id> <CLAUDE_CONFIG_DIR>/autoEvolve/arena/worktrees/<id> HEAD` with `realpathSync` on both sides to defeat macOS `/tmp` ↔ `/private/tmp` symlink mismatch; idempotent (re-spawn returns same path) + branch-reuse (leftover branch + deleted worktree → `git worktree add <path> <branch>`) + refuse-overwrite (directory exists but not a registered worktree → fail, preserve user files); cleanup is tri-stage `worktree remove --force` → `branch -D` → residual `rmSync`, branch-delete failure does not flip success to false. |
| Promotion FSM | `services/autoEvolve/arena/promotionFsm.ts` | Allowed transitions, signed transition ledger, vetoed-ids persistence |
| Fitness Oracle | `services/autoEvolve/oracle/fitnessOracle.ts` | 5-dim scoring, SHA-256 signed, appended to `fitness.ndjson`. **Phase 27**: `loadOracleWeights()` now follows a 3-layer priority — tuned (`oracle/tuned-oracle-weights.json`, Phase 27 auto-tuner) → base (`oracle/weights.json`, user-editable) → `DEFAULT_ORACLE_WEIGHTS`. `safetyVetoEnabled` always flows from the base layer (tuned snapshot never carries a safety field because safety is a veto switch, not a weight). Tuned is loaded via a dynamic `require('./metaEvolver.js')` to sidestep circular imports; missing or corrupt tuned snapshot silently falls through to base. Resulting `version` string is concatenated `<base>+tuned@<updatedAt>` for audit traceability. |
| Fitness Observer | `services/autoEvolve/oracle/fitnessObserver.ts` | Pure mapping DreamEvidence → FitnessInput; piggybacks `evidenceBus.convergeDreamEvidence` |
| Session×Organism Ledger | `services/autoEvolve/oracle/sessionOrganismLedger.ts` | Phase 7 — append `{ sessionId, organismId, at }` on every stable invocation; `getSessionsForOrganism(id)` reverse-lookup. NDJSON at `oracle/session-organisms.ndjson`, failure-silent |
| Oracle Aggregator | `services/autoEvolve/oracle/oracleAggregator.ts` | Phase 7 — reverse-attribute session-level FitnessScores to organisms using the ledger. `aggregateOrganismFitness(id)` / `aggregateAllOrganisms()` / `bucketScore(score)` bucket scores (≥0.3 win, ≤-0.3 loss, else neutral) and return `{ trials, wins, losses, neutrals, avg, lastAt, lastScoreSignature }`. **Phase 24**: all three call sites now read `loadTunedThresholds().organismWinThreshold / organismLossThreshold` at call time (not boot), so `/evolve-tune --apply` updates propagate instantly via the tuner's mtime cache — exported `ORGANISM_WIN_THRESHOLD=0.3 / ORGANISM_LOSS_THRESHOLD=-0.3` stay as compat defaults when no tuned file exists. |
| Skill-loader bridge | `services/autoEvolve/index.ts#ensureStableGenomeRegistered` + `arenaController.registerStableGenomeAsSkillDir` | On stable promotion (and on `/evolve-status` boot), register `genome/stable/` via `addSkillDirectories`, then run `wrapStableSkillsWithInvocationHook` |
| Invocation hook | `arenaController.wrapStableSkillsWithInvocationHook` | Walk `getDynamicSkills()`, pick prompt-type skills whose `skillRoot` is under `genome/stable/`, replace `getPromptForCommand` with a bump-first wrapper. Phase 7: wrapper also `recordSessionOrganismLink(organismId)` to feed the Aggregator. WeakSet-protected (single wrap per Command object). |
| Auto-Promotion Engine | `services/autoEvolve/emergence/autoPromotionEngine.ts` | Per-tier thresholds: shadow→canary (invocations≥3, age≥1d); canary→stable (invocations≥10, age≥3d). Oracle macro-gate holds all when recent avg < -0.5. Phase 7 fuses per-organism fitness: `wins<losses` with `trials≥3` → hold (adverse veto); `avg≥0.3` with `trials≥2` → relax age threshold by 50%. Emits Decision[] for preview; applyAutoPromotions writes signed auto-oracle transitions. Phase 9: `applyAutoPromotions` calls `refreshAllOrganismFitness()` before evaluate so `decide()` reads the freshest aggregate, not a stale persisted snapshot. **Phase 22**: `decide()` invokes `detectCheating(manifest, status)` AFTER the global oracle gate but BEFORE `per_org_adverse` — because wins/losses statistics themselves can be gamed, Goodhart must screen first. A positive verdict returns `action='hold'` with `reason='goodhart_veto: <rules>'` and surfaces the hit rules in `metrics.goodhartReasons[]`. **Phase 24**: the `-0.5` global oracle gate is now `loadTunedThresholds().oracleAdverseAvg` — `evaluateAutoPromotions` loads tuned once per tick and forwards the value into `decide(m, gatedByOracle, oracleAvg, oracleAdverseAvgThreshold)` so the "reason" string (`avg=… < X`) always references the same X used for gating. Exported `ORACLE_ADVERSE_AVG_THRESHOLD=-0.5` survives as compat default. |
| Auto-Archive Engine | `services/autoEvolve/emergence/autoArchiveEngine.ts` | Phase 8 scans shadow/proposal for `expiresAt < now` (trigger='auto-age'); Phase 10 adds a second scan path over stable for `daysSinceLastInvoke > STALE_STABLE_UNUSED_DAYS` (default 45d, guarded by STALE_STABLE_MIN_AGE_DAYS=14d grace) emitting trigger='auto-stale'. Both paths share the same ArchiveDecision/ArchiveApplyResult types; `applyAutoArchive({dryRun})` reuses `promoteOrganism({toStatus:'archived', trigger: d.trigger})` — same FSM/signed-ledger path, no new transition code. Not gated by Oracle macro trend (expiry + stale are independent facts). |
| Archive Retrospective | `services/autoEvolve/emergence/archiveRetrospective.ts` | Phase 11 — pure-read summarizer. `summarizeTransitions({windowDays=30})` reads `promotions.ndjson` in full (bad-line-skip, same discipline as `readRecentTransitions`), time-filters to the window, then groups by `TransitionTrigger` and `(from→to)` edge, with sub-views for `archivals` (to ∈ archived/vetoed) and `promotions` (to ∈ shadow/canary/stable/proposal). `topN(record, n)` helper ranks edge counts for UI. Zero writes, zero FSM involvement. Exposed in `/evolve-status` section 1.8. |
| NDJSON Ledger | `services/autoEvolve/oracle/ndjsonLedger.ts` | Phase 12 — generic append+rotate utility shared by all 3 ledgers. `appendJsonLine(path, obj, opts?)` writes `JSON.stringify(obj)+'\n'` after a best-effort `rotateIfNeeded(path)`: when main file size > MAX_LEDGER_BYTES (10MB default), rename `.N → .N+1` (oldest dropped beyond MAX_ROTATED_FILES=3), `main → .1`, recreate empty main. Rotation uses POSIX-atomic `renameSync` + `writeFileSync('')`; rotation failure silently degrades to plain append (logForDebugging, never blocks write path). Exported `rotateIfNeeded(path, opts?)` for /evolve-tick maintenance calls. Opts `{maxBytes, maxRotations}` override for tests + ops. Replaces raw `appendFileSync` in: promotionFsm.recordTransition, sessionOrganismLedger.recordSessionOrganismLink, fitnessOracle.scoreAgainstDimensions. Read-side (readRecentTransitions / recentFitnessScores / readSessionOrganismLinks / archiveRetrospective) is untouched — rotated `.1/.2/.3` files are cold archives, not queried. |
| Body Renderers | `services/autoEvolve/emergence/bodyRenderers.ts` | Phase 13 — per-kind primary body renderers for skillCompiler. `renderBodyForKind(kind, candidate)` returns `RenderedBody = { primary: BodyArtifact; extras?: BodyArtifact[] }`. Five paths: skill → `SKILL.md` (byte-identical to Phase 1's `renderSkillBody` — preserves Phase 4 skill loader contract and stable organisms' attribution keys); command → `<name>.md` with frontmatter `{description, allowed-tools: [], argument-hint, status, kind}` + prompt-body skeleton; agent → `<name>.md` with frontmatter `{name, description, tools: [], model: inherit, status, kind}` + system-prompt skeleton; hook → `hook.sh` (shebang + rationale comments + TODO skeleton, no fabricated execution logic) plus `extras=[hook.config.json]` (structured reviewer hints: suggestedEvent='PreToolUse', suggestedMatcher='TODO', command-path, reviewer-instructions array); prompt → `PROMPT.md` reusable snippet. `ALL_PRIMARY_FILENAMES` is the allow-list used by skillCompiler's stale-cleanup pass when a re-compile changes kind. Pure rendering — zero I/O, zero loader coupling. |
| Kind Installer | `services/autoEvolve/arena/kindInstaller.ts` | Phase 14 — per-kind loader install/uninstall at promoteOrganism step 6. `installKindIntoClaudeDirs(manifest, orgDir): InstallResult` dispatches by kind: skill → no-op (handled by Phase 4 `registerStableGenomeAsSkillDir`); command → `symlinkSafe` from `<orgDir>/<name>.md` to `<claudeBase>/commands/<name>.md`; agent → same pattern into `<claudeBase>/agents/<name>.md`; hook → `copyFileSync` hook.sh + hook.config.json into `<autoEvolveRoot>/installed-hooks/<id>/` (chmod 0755) + appendJsonLine to `pending-hooks.ndjson` with `{action:'install', organismId, name, suggestedEvent, suggestedMatcher, commandPath, rationale, at, hint}` so a reviewer can paste the entry into `settings.json` (autoEvolve never mutates settings.json — user-root permission boundary); prompt → no-op (reference-only). `symlinkSafe` outcomes: `created` / `existed-correct` (idempotent) / `skip-user-file` / `skip-other-symlink` / `error` — never overwrites anything we didn't create. `uninstallKindFromClaudeDirs(manifest): UninstallResult` mirrors the install: unlink only if target is a symlink (user files left in place), rm -rf the hook install dir, append `{action:'uninstall'}` to pending-hooks.ndjson. All failures are non-fatal (logForDebugging), never roll back the signed promotion ledger. **Phase 16** adds `previewInstallKindIntoClaudeDirs` / `previewUninstallKindFromClaudeDirs` — pure dry-run twins that share the lstat decision logic via a private `peekSymlink` helper but never write: no `symlinkSync`, no `copyFileSync`, no `appendJsonLine`, no `ensureDir`. Returned shape matches the real functions (`installed/cleaned` always false, reason prefixed `(preview)`), so callers like `/evolve-accept --dry-run` can show the would-be `artifacts[]` paths before the user commits. |
| Pending Hooks Reader | `services/autoEvolve/arena/pendingHooksReader.ts` | Phase 15 — read-only aggregation over `pending-hooks.ndjson` + `installed-hooks/`. `readPendingHookEvents(): PendingHooksSummary` parses the ndjson line-by-line and reconciles install↔uninstall per `organismId`: later uninstall cancels an earlier install (both → `canceled` counter), uninstall without a matching install → `orphanUninstalls`, malformed JSON lines → `malformedLines` counter. Active installs (install not yet offset) are sorted by `at` and returned. `listInstalledHookOrganismIds(): string[]` walks the filesystem to enumerate `installed-hooks/<id>/` dirs that actually contain `hook.sh`. `formatPasteReadyHookJson(event): string` serializes a valid JSON snippet matching Claude Code's `settings.json` hooks schema — `{[event]: [{matcher, hooks: [{type:"command", command}]}]}` — which the reviewer can paste as-is. All I/O is wrapped in try/catch; rotated ledger archives (`.1/.2/.3`) are not read (hot-path only). |
| /evolve-accept | `commands/evolve-accept/index.ts` | Phase 2 + **Phase 16** — human-in-the-loop promoter. Parses `<id> [--to=<status>] [--dry-run] [rationale...]`, resolves current status via `listAllOrganisms`, defaults next tier via `shadow→canary / canary→stable`. Phase 16 additions: (a) `--dry-run` runs `isTransitionAllowed` + `renderSideEffectPreview` (which calls `previewInstallKindIntoClaudeDirs` from kindInstaller) and returns a `**Preview**` block with expected symlink / copy / pending-hooks paths, touching NO disk state; (b) real `stable` promotions of `kind=hook` additionally emit a paste-ready `settings.json` snippet inline by reading back the freshly-appended install event via `pendingHooksReader.formatPasteReadyHookJson` — reviewer no longer needs to open `/evolve-status` to retrieve it; (c) both paths run FSM pre-check before any write, so illegal transitions fail identically in preview and real mode. Non-stable target statuses (canary, proposal) render "(no Phase 14 side effects)" to keep noise low. |
| /evolve-veto | `commands/evolve-veto/index.ts` | Phase 2 + **Phase 17** — manual veto path. Moves shadow/canary organism to `vetoed/` via `vetoOrganismWithReason`, which records a signed `manual-veto` transition AND merges the organism's `sourceFeedbackMemories` into `oracle/vetoed-ids.json` so `minePatterns` skips the same feedback next time. Terminal: vetoed/archived cannot be vetoed, and the FSM table also blocks stable→vetoed (stable must go through archived). Phase 17 additions: (a) `--dry-run` flag previews the transition without writing — runs `isTransitionAllowed` pre-check + `renderUninstallPreview` (defensive; unreachable for FSM-rejected stable→vetoed but kept robust) + `renderVetoedIdsPreview` which diffs `manifest.origin.sourceFeedbackMemories` against `readVetoedFeedbackMemories()` and reports the `added` list with `+` prefix; (b) both dry-run and real paths share the same FSM pre-check, so illegal transitions surface the same `rejected by FSM` message identically; (c) no disk writes in dry-run path: `oracle/vetoed-ids.json` stays untouched, status directories untouched. |
| /evolve-archive | `commands/evolve-archive/index.ts` | **Phase 18** — manual recycle path. Moves `proposal/shadow/canary/stable` organism to `archived/` via `archiveOrganismWithReason`, which records a signed `manual-archive` transition (new TransitionTrigger). Critically, `stable → archived` IS allowed by FSM (unlike stable→vetoed), so this command is the first real caller that actually reaches Phase 17's `renderUninstallPreview` body — stable organisms with `kind=hook/command/agent` get their loader artifacts cleaned via `uninstallKindFromClaudeDirs` (symlink unlink, `installed-hooks/<id>/` rm, `pending-hooks.ndjson` append). **Semantic contrast with /evolve-veto**: archive does NOT merge source feedback memories into `oracle/vetoed-ids.json` — it means "retire this instance", not "blacklist the source"; Pattern Miner can still re-mine the same memory next pass. `--dry-run` mirrors the Phase 16/17 pattern. FSM rejects `archived→archived` and `vetoed→archived` (both terminal states). **Phase 21** adds `--purge-settings`: after a successful archive, chains `removeHookFromSettings(id, rationale)` (from Phase 20's settingsHookInstaller) so orphan settings.json entries get cleaned too. OFF by default (preserves Phase 18 semantics); activates only when `kind=hook && fromStatus=stable` (other combos print a no-op rationale). Chain runs AFTER archive commit — settings removal failures do not roll back the archive. Phase 20's `hand-modified` detection propagates through: a reviewer-renamed command is left in place with a warning rather than being guessed-and-deleted. `--dry-run --purge-settings` renders both the Phase 14 uninstall preview AND the Phase 21 `Phase 21 --purge-settings (preview)` block in one pass. |
| Status command | `commands/evolve-status/` | Read-only diagnostic panel (9 sections; Phase 8 adds Auto-Archive Preview next to Auto-Promotion Preview; Phase 10 expands it to show both auto-age + auto-stale decisions side by side with per-trigger key metric column: overdueDays vs daysSinceLastInvoke; Phase 11 adds section 1.8 Archive Retrospective with 30d window trigger + edge histogram). Phase 9 boot hook: calls `refreshAllOrganismFitness()` after `ensureStableGenomeRegistered()` so the panel's stable rows show live-refreshed `manifest.fitness`. |
| Accept command | `commands/evolve-accept/` | Manual promotion shadow→canary→stable |
| Veto command | `commands/evolve-veto/` | Manual veto + Pattern Miner dedup via `vetoed-ids.json` |
| Tick command | `commands/evolve-tick/` | Preview or apply auto-promotions + auto-archives; `--apply` requires CLAUDE_EVOLVE=on. Archive runs after promotion, independent try/catch. **Phase 19**: in `dryRun=true` mode (default, OR `--apply` downgraded by CLAUDE_EVOLVE=off) appends a "Phase 14 Side Effects Preview" section that filters `applyAutoPromotions.decisions` for `action='promote' && to='stable'` (install preview) and `applyAutoArchive` decisions for `from='stable'` (uninstall preview). Manifests are loaded at render-time via `readOrganism(d.from, d.organismId)` — engine API signatures untouched. Preview is suppressed under real `--apply` because side effects have already fired. |
| Settings Hook Installer | `services/autoEvolve/arena/settingsHookInstaller.ts` | **Phase 20** — semi-automatic merge/unmerge of pending-hooks install events into `~/.claude/settings.json.hooks`. `mergeHookIntoSettings(event, rationale?)` reads the current hooks block (deep-cloned via `getSettingsForSource('userSettings')` + JSON roundtrip), computes the merged block (appends `{type:'command', command}` into `hooks[event][matcher].hooks`, creating matcher bucket if missing, idempotent on exact-match duplicate), and writes via `updateSettingsForSource('userSettings', {hooks: next})` — passes the *complete* hooks block because lodash mergeWith in the writer replaces arrays rather than merging. `previewMergeHookIntoSettings` is the pure-read twin. **Reverse-uninstall authority lives in the autoEvolve-owned `installed-settings.ndjson` audit ledger** (new path `getInstalledSettingsLedgerPath`, under Phase 12 ndjsonLedger rotation), NOT in settings.json — so no sentinel pollutes merged entries, and `findLatestMergedTarget(organismId)` replays `merge`/`unmerge` lines to reconstruct state. `removeHookFromSettings(id)` resolves the target via that ledger, exact-matches `{event, matcher, command}` in the live hooks block, splices the entry, and auto-cleans empty matchers/events. Distinguishes four removal outcomes: `ok` (match + spliced), `already-present`/`nothing-to-remove` (nothing to do), `hand-modified` (reviewer renamed command — refuses to guess). Atomic write inherited from `updateSettingsForSource`; audit-ledger append uses `appendJsonLine` (ledger-append failure logs but does NOT roll back the successful settings.json write — same "real effect trumps audit line" discipline as Phase 14). |
| /evolve-install-hook | `commands/evolve-install-hook/index.ts` | **Phase 20** — reviewer command wrapping `settingsHookInstaller`. Parses `<id> [--dry-run] [--remove] [reason...]`. Install path: looks up the active install event in `pending-hooks.ndjson` via `readPendingHookEvents().active`, errors cleanly if organism isn't stable / isn't `kind=hook` / a later uninstall canceled the install. Remove path: reads audit ledger via `findLatestMergedTarget(id)`, uses the recorded `(event, matcher, command)` as removal key. `--dry-run` prints before/after hooks JSON blocks without touching disk. Real mode prints settings path + outcome + `merge`/`unmerge` ledger append note. Command is idempotent: repeat install → `reason='already-present'` (no write, no ledger append); repeat remove after prior remove → `nothing-to-remove`. |
| Goodhart Guard | `services/autoEvolve/oracle/goodhartGuard.ts` | **Phase 22** — anti-cheat detector for the auto-promotion decision path. `detectCheating(manifest, status, opts?)` is a pure read function that runs four independent rules against an organism's body + contributing FitnessScore[] + per-organism aggregate: **R1 trivial-body** (non-prompt organism's body has <`MIN_BODY_BYTES=64` non-whitespace chars across all non-manifest files); **R2 flat-dimensions** (≥`FLAT_DIMS_FRACTION=0.8` of contributing scores have `userSatisfaction==taskSuccess==codeQuality==performance`, across ≥`FLAT_DIMS_MIN_TRIALS=5`); **R3 sudden-jump** (contributing scores sorted by time, len≥`JUMP_MIN_LEN=6`, first-half avg ≤`JUMP_FIRST_HALF_UPPER=0` AND second-half avg ≥`JUMP_SECOND_HALF_LOWER=0.8`); **R4 perfect-record** (per-organism aggregate `trials≥PERFECT_MIN_TRIALS=10 && losses==0 && avg≥tuned.goodhartPerfectAvgMin (default 0.95)`). Returns `GoodhartVerdict = { suspicious, reasons[], detail, metrics }`. On `suspicious && !skipAudit` appends an audit line to `oracle/goodhart.ndjson` (Phase 12 rotation). `recentGoodhartVetoes(limit=20)` reads the tail for future `/evolve-status` diagnostics. Override hooks (`scoresOverride / bodyBytesOverride / aggregateOverride`) enable pure-function unit testing without touching the ledger. Wired into `autoPromotionEngine.decide()` as a hold gate positioned BEFORE `per_org_adverse` — because statistics on gamed scores are themselves untrustworthy. Manual `/evolve-accept` deliberately bypasses the guard so human judgment always outranks machine pattern-matching. **Phase 24**: R4's `avg ≥ 0.95` threshold now reads `loadTunedThresholds().goodhartPerfectAvgMin` so `/evolve-tune --apply` can relax/tighten it per real fitness distribution. |
| Threshold Auto-Tuner | `services/autoEvolve/oracle/thresholdTuner.ts` | **Phase 24** — percentile-based auto-tuning for the four hardcoded decision thresholds that drift most against a user's real fitness distribution: `oracleAdverseAvg` (autoPromotionEngine global gate), `organismWinThreshold` / `organismLossThreshold` (oracleAggregator buckets), `goodhartPerfectAvgMin` (goodhartGuard R4). `TunedThresholds` is a small `version:1` JSON snapshot at `oracle/tuned-thresholds.json`. `loadTunedThresholds()` uses mtime-cached reads with field-level fallback to `DEFAULT_TUNED_THRESHOLDS` (= exact previous hardcoded values), so missing/corrupt/partial files never crash the decide path — they just revert to the old behavior. `saveTunedThresholds(next)` writes the snapshot, invalidates the cache, and bumps `updatedAt`. `computeTuningSuggestion(windowDays=30, opts?)` reads the last 50k fitness scores, filters to window, and for each threshold emits `{current, suggested, rationale, dataPoints}`: `oracleAdverseAvg ≈ p10 of overall (clamped [-1,-0.1])`, `organismWinThreshold ≈ median of positives (clamped [0.1,0.8])`, `organismLossThreshold ≈ median of negatives (clamped [-0.8,-0.1])`, `goodhartPerfectAvgMin ≈ max(positive p99, 0.9) (clamped [0.9,0.99])`. Below `MIN_SAMPLES_FOR_TUNE=10` it auto-degrades: every row keeps current, `insufficientReason` is populated, and `/evolve-tune --apply` refuses to write. Consumers read tuned values at call time (not boot time) so `--apply` propagates instantly via mtime invalidation — no service restart needed. Exported constants `ORACLE_ADVERSE_AVG_THRESHOLD=-0.5`, `ORGANISM_WIN_THRESHOLD=0.3`, `ORGANISM_LOSS_THRESHOLD=-0.3`, `PERFECT_AVG_MIN=0.95` stay as compat defaults so any out-of-tree importer keeps working. |
| /evolve-tune | `commands/evolve-tune/index.ts` | **Phase 24** — reviewer entry to `thresholdTuner`. Hidden command parsing `[--window DAYS] [--apply] [--reset]`. Default dry-run prints an aligned `name / current / suggested / delta` table plus each row's rationale (percentile + clamp range + data point count) and is strictly read-only. `--window N` narrows the fitness history window (1..365). `--apply` persists the suggestion to `oracle/tuned-thresholds.json`; auto-skipped (with a clear message) when `insufficientReason` is set so low-data environments never overwrite a previously tuned file. `--reset` deletes the snapshot so all consumers fall back to `DEFAULT_TUNED_THRESHOLDS`. `--apply` and `--reset` are mutually exclusive. Unknown flags, missing `--window` values, and non-integer windows produce usage errors. |
| Oracle Meta-Evolver | `services/autoEvolve/oracle/metaEvolver.ts` | **Phase 27** — SNR-based auto-tuner for the 4 Oracle weight dimensions (userSatisfaction / taskSuccess / codeQuality / performance). `TunedOracleWeights` is a small `version:1` JSON snapshot at `oracle/tuned-oracle-weights.json` — deliberately excludes `safetyVetoEnabled` (safety is a veto switch, not a weight, so it must not be tuned). `loadTunedOracleWeights()` uses mtime-cached reads with field-level fallback to `DEFAULT_TUNED_ORACLE_WEIGHTS` (= DEFAULT_ORACLE_WEIGHTS's 4-dim mapping). Unlike thresholdTuner, **missing file returns `null`** (not defaults) so `loadOracleWeights()` can distinguish "no tuned → fall through to base/DEFAULT" from "tuned present → use it". `saveTunedOracleWeights(next)` writes the snapshot, invalidates cache, and clamps every field to `[WEIGHT_MIN=0.05, WEIGHT_MAX=0.7]` on the way in. `computeWeightSuggestion(windowDays=30)` reads the last 2000 fitness scores, filters to the window, buckets win/loss using **Phase 24's tuned thresholds** (so metaEvolver and oracleAggregator share bucket semantics), computes per-dimension `SNR = |mean(win) - mean(loss)| / (std(all) + ε)`, normalizes proportional to SNR, clamps to `[0.05, 0.7]` (prevents both monopoly and starvation), and re-normalizes. Below `MIN_SAMPLES_FOR_META=20` it auto-degrades: every row keeps current, `insufficientReason` is populated, and `/evolve-meta --apply` refuses to write. `suggestionToNext(s)` converts a suggestion to a ready-to-save `TunedOracleWeights`. Rationale strings classify by SNR tier: `SNR≈0 → floor`, `<0.2 → shrink`, `<0.6 → standard`, `≥0.6 → boost`. |
| /evolve-meta | `commands/evolve-meta/index.ts` | **Phase 27** — reviewer entry to `metaEvolver`. Hidden command parsing `[--window DAYS] [--apply] [--reset] [--force]`. Default dry-run prints an aligned `name / current / suggested / delta / SNR` table plus per-row rationale and a reminder that safety is a VETO switch (never tuned). Strictly read-only in dry-run. `--window N` narrows the fitness history window (1..365). `--apply` persists the suggestion to `oracle/tuned-oracle-weights.json` (auto-skipped with a clear message when `insufficientReason` is set, to protect any previously-saved tuned file from being nuked back to defaults). `--reset` deletes the snapshot and resets the mtime cache via `_resetTunedOracleWeightsCacheForTest`, so `loadOracleWeights()` falls back to base `weights.json` or `DEFAULT_ORACLE_WEIGHTS` on next read. `--apply` and `--reset` are mutually exclusive. Consumers pick up new weights on next `scoreSubject` call without a service restart (mtime invalidation propagates instantly). **Phase 28 soft-gate**: `--apply` runs `benchmarkLedger.computeDrift()` immediately after the insufficient-data check and before `saveTunedOracleWeights`; if `drift.suspicious === true` and `--force` is absent, `--apply` refuses to write tuned weights and prints the suspicious benchmark rows + a remediation hint to either inspect with `/evolve-bench --drift` or override with `--apply --force`. Insufficient benchmark data or `suspicious=false` → no gate (new installs are never blocked). `--force` logs `"overridden via --force"` + the drift reason before writing, so the override is preserved in shell scrollback for audit. |
| Benchmark Ledger | `services/autoEvolve/oracle/benchmarkLedger.ts` | **Phase 28** — Oracle-level anti-Goodhart registry + regression engine. Two artifacts: `oracle/benchmarks.json` is **user-editable** (`BenchmarksFile = { version:1, benchmarks: BenchmarkEntry[] }`) — reviewer-curated canonical tasks, autoEvolve never auto-populates it; `oracle/benchmark-runs.ndjson` is append-only (goes through Phase 12 `appendJsonLine` so 10MB rotation is inherited) with per-run `{ runId, benchmarkId, organismId?, at, oracleWeightsVersion, score, dimensions?, signature }` where `oracleWeightsVersion` is snapshotted from `loadOracleWeights().version` at record time so drift detection sees real transition edges. `readBenchmarks()` uses mtime-cached reads with field-level skip of malformed rows (bad entries don't poison the whole registry). `addBenchmark()` enforces id regex `/^[A-Za-z0-9_-]{1,64}$/` + non-empty description, and on id collision **preserves the original `createdAt`** so re-registering for a description tweak doesn't reset the timestamp. `recentBenchmarkRuns(limit=500)` inlines its own `split('\n') + JSON.parse` loop rather than going through any shared reader — intentional isolation so benchmark runs never accidentally flow through the Phase 26 organism attribution path. Core audit: `computeDrift({ windowRuns, driftThreshold=0.3, minSuspiciousBenchmarks=3 })` groups by `benchmarkId → oracleWeightsVersion → scores[]`, computes pairwise `|meanA - meanB|`, flags rows over `driftThreshold`, and only returns `suspicious=true` when the **set of flagged benchmarks** meets `minSuspiciousBenchmarks` (chose "many benchmarks simultaneously drift" over "one benchmark drifts hard" because single-benchmark noise shouldn't lock `/evolve-meta --apply`). Insufficient data → `suspicious=false` + `reason: 'insufficient data: need ≥2 oracleWeightsVersion per benchmark to compare'`. Deliberately **does not share `fitness.ndjson`**: benchmark scoring would otherwise distort `aggregator.avgScore` and could accidentally trigger auto-archive on organisms being stress-tested. |
| /evolve-bench | `commands/evolve-bench/index.ts` | **Phase 28 + Phase 29** — reviewer entry to `benchmarkLedger`. Hidden command with five mutually-exclusive modes: `--list` prints the canonical registry with description + acceptance criteria; `--add <id> --desc "..." [--criteria "..."]` registers (or overwrite-description of) one canonical task with id regex + empty-description guardrails; `--record --id <benchmarkId> --score <n> [--organism <id>] [--weights-version <str>]` appends one run to `benchmark-runs.ndjson` — if `--weights-version` is omitted it defaults to `loadOracleWeights().version` at record time, and unknown benchmarkId is rejected with a clear remediation hint (`Register it first with /evolve-bench --add`); `--drift [--threshold 0.3] [--min-benchmarks 3] [--window 500]` runs `computeDrift` and prints an aligned `benchmarkId / versionA / versionB / meanA / meanB / Δ / susp?` table plus the `reason` line and the Phase 28 soft-gate warning when suspicious; **`--mine [--top 10] [--window 2000] [--min-delta 0.3] [--min-extremity 0.5] [--include-registered]` (Phase 29)** scans `fitness.ndjson` for high-signal subjects (cross-Oracle-version Δ or decisive-mean) and proposes them as canonical-benchmark candidates, printing an `informativeness / Δver / mean / n / rationale` table plus a `suggestedId ← subjectId=... organismId=...` mapping footer so the reviewer can `/evolve-bench --add <suggestedId>` without guessing. All five subcommands are strictly mutually exclusive (parsing error if combined), required values are validated (score must be finite, threshold must be positive, min-benchmarks must be ≥1, window must be 1..100000, top must be 1..500, min-extremity must be in [0,1]), and read-only modes (`--list`, `--drift`, `--mine`) make no writes — even `--mine` leaves `benchmarks.json` / `benchmark-runs.ndjson` untouched. `--window` is shared between `--drift` and `--mine` (same "how many lines to look back" semantic). |
| /evolve-arena | `commands/evolve-arena/index.ts` | **Phase 30 + Phase 33** — parallel multi-arena worktree controller + shadow/ priority scheduler. Wraps `arenaController`'s Phase 30 batch APIs (`spawnOrganismWorktreesBatch` / `cleanupOrganismWorktreesBatch` / `listActiveArenaWorktrees`, plus the `MAX_PARALLEL_ARENAS=8` hard cap) and `arenaScheduler`'s Phase 33 read APIs (`listShadowPriority` / `pickNextShadowIds`). Six mutually-exclusive modes: `--list` enumerates `arena/worktrees/<id>/` directories (always read-only, works even when `CLAUDE_EVOLVE_ARENA` is off, so reviewers can audit residue without flipping the flag); **`--schedule [N]` (Phase 33)** prints the shadow/ priority queue as an aligned `# / id / prio / trials / ageDays / stale / kin / name` table with a `priority components` footer showing the weighted-sum formula (`trials×0.45 + stale×0.30 + age×0.15 + kin×0.10`) — strictly read-only, works with the flag off, `N` defaults to all entries (1..500); `--spawn <id> [<id> ...] [--max-parallel N]` batch-spawns organism worktrees with per-id `✓/✗` status output + `worktreePath` + `branch:` line on success; **`--spawn-auto N [--max-parallel N]` (Phase 33)** lets `pickNextShadowIds(N)` pick top-N from shadow/ and forwards them to `spawnOrganismWorktreesBatch` — same cap semantics as `--spawn`, graceful `(none — shadow/ empty or all active)` when no candidates, `N` required in 1..64; `--cleanup <id> [<id> ...]` batch-cleans individual ids (one failure doesn't contaminate siblings); `--cleanup-all` teardown-helper that forwards `listActiveArenaWorktrees().map(a=>a.id)` to `cleanupOrganismWorktreesBatch` — handy for end-of-batch sweep. Cap enforcement: if `active_before + new_ids > min(--max-parallel, MAX_PARALLEL_ARENAS)` the whole batch is rejected (entries=[], `capHit` populated) — deliberate whole-hog refusal so callers never guess which ids made it through. `--max-parallel` validated to 1..64 at parse time then re-clamped inside the batch function. `--spawn` / `--cleanup` require at least one id; `--schedule` / `--spawn-auto` are spawn-cap-safe (`--schedule` never touches disk, `--spawn-auto` inherits the same cap as `--spawn`); empty-args / unknown-flag / missing-id / mode conflicts all produce helpful usage errors. `--list` and `--schedule` are always available; `--spawn` / `--spawn-auto` / `--cleanup` / `--cleanup-all` require `CLAUDE_EVOLVE_ARENA=on`. Registered in `commands.ts` right after `evolveBench`. |
| /evolve-kin | `commands/evolve-kin/index.ts` | **Phase 31** — cross-organism kinship lookup. Wraps `services/autoEvolve/arena/kinshipIndex.ts` — `findKinStableOrganisms(proposalText, {topK?, minSimilarity?, includeManifestBody?}) → KinshipResult` runs token-level Jaccard similarity (EN + CJK stop-word filtered, char-level CJK splitting so no dictionary dep is needed) between the proposal and each stable organism's `manifest.name + rationale + winCondition` (+ primary body — file chosen by iterating `ALL_PRIMARY_FILENAMES` from `emergence/bodyRenderers.ts`); returns topK sorted descending with `rationalePreview` / `bodyPreview` / `bodyPath`. `suggestSeedBody(proposalText, opts?)` grabs the top1 match and prefixes its primary body with `<!-- kin-seeded from stableId=X similarity=Y source=FILENAME -->` for audit; empty stable/, sub-threshold kin, or body-less top kin returns `{seedBody: '', strategy: 'empty', reason}` so callers fall back to a blank template (deliberately **not** falling back to `proposalText`, which would pollute SKILL.md with meta description). Defaults `topK=5` clamp [1,50], `minSimilarity=0.1` (empirically tuned — 0.2 was too strict against realistic body sizes), `includeManifestBody=true`. Two mutually-exclusive modes: `--match "<text>"` prints the aligned `# / stableId / sim / name` table with rationale/body previews; `--seed "<text>"` adds the kin-seeded body between `--- BEGIN/END seedBody ---` markers (CLI-preview truncated at 2000 chars; programmatic API returns full). `--top N` (1..50), `--min-sim F` ([0,1]), `--no-body` flips `includeManifestBody`. Proposal text parsed via `tokens.match(/"[^"]*"|\S+/g)` so quoted multi-word inputs survive. Module is **read-only** (never writes stable/, never touches ledgers) and **independent of `CLAUDE_EVOLVE_ARENA`** (pure disk scanning). Registered in `commands.ts` right after `evolveArena`. |
| /evolve-lineage | `commands/evolve-lineage/index.ts` | **Phase 34** — genome lineage visualizer. Wraps `services/autoEvolve/arena/lineageBuilder.ts` — `buildLineageForest() → {trees, allNodes, byId, stats}` does one `listAllOrganisms()` scan, resolves each `manifest.kinSeed.stableId` against the in-memory map to attach children, detects orphans (kinSeed points at a non-existent id) / self-references (kinSeed→self → `cycle=true`, stops DFS); each `LineageNode` carries `{status, name, kind, kinSeed, maturity:{shadowTrials, wins, losses, neutrals, lastTrialAt, winRate, ageDays}, children, depth, orphanOfId, cycle}` (winRate=null when no samples, so the ASCII renderer shows `—` instead of a misleading 0.00). Children arrays and root list are sorted by id lexical order (same discipline as Phase 33 scheduler tie-break) so output is reproducible. `renderLineageAscii(trees, {maxDepth?, showKin?})` emits ASCII with classic `├─ ` / `└─ ` connectors + `│   ` / 4-space continuations; non-root lines format as `id [status] (name) winRate=… trials=… age=…d`, child lines additionally getting `[sim=<jaccard> · src=<file>]` tags unless `--no-kin`, orphans/cycles getting `[ORPHAN→<id>]` / `[CYCLE!]`; `--max-depth` truncation prints `…  (N subtree(s) hidden; raise --max-depth)` so the collapse is explicit. `summarizeLineage(forest) → LineageStats` aggregates `{total, roots, orphans, maxDepth, byStatus, kinnedNodes, kinDisabled, largestFamily}` — `kinnedNodes` counts organisms whose kinSeed actually resolves (distinguishing "nominal kin" from "real kin"), `kinDisabled` surfaces `kinSeed=null` organisms (Phase 32 explicitly off), `largestFamily` identifies the root with the most descendants. Three mutually-exclusive modes: `--tree [root-id] [--max-depth N] [--no-kin]` prints full forest (with `total=… roots=… orphans=… maxDepth=…` header + trailing `legend:` line) or single subtree; `--stats` prints aggregate summary with aligned `by status:` rows + `largest family: <id>  (N nodes in subtree)` tail; `--json [root-id]` emits machine-readable dump — forest form returns `{stats, trees[]}`, subtree form returns the single stripped node (children nested), both stripping parent-direction refs to avoid JSON cycles, preserving `cycle` / `orphanOfId` flags. Parser enforces discipline: exactly one mode flag, at most one positional root-id, `--max-depth` integer 1..64, unknown flags surface with USAGE. Entirely **pure-read** (no disk writes, no feature-flag gating) — runs safely regardless of `CLAUDE_EVOLVE_*` env. Registered in `commands.ts` right after `evolveKin`. |
| /evolve-warmstart | `commands/evolve-warmstart/index.ts` | **Phase 35** — cold-start warmstart library. Wraps `services/autoEvolve/emergence/warmstartLibrary.ts` — an in-code curated catalog of 7 baseline `BaselineTemplate {slug, pitch, kind, pattern, nameSuggestion, rationale, winCondition, tags[]}` entries (review-guard / safe-rm-guard / commit-msg-guard / test-flaky-retry / memory-audit / verify-before-claim / skillify-reminder). `listBaselines()` returns defensive copies (each `tags` array is cloned) so callers can't corrupt the catalog; `findBaseline(slug)` does exact lookup. `seedWarmstart({include?, exclude?, dryRun?, force?}) → {attempted, dryRun, entries, counts}` lifts each baseline into a real `PatternCandidate` via `baselineToPatternCandidate` (evidence.sourceFeedbackMemories=`['warmstart:<slug>']`, coveredByExistingGenome=false, id=`pat-warm-<slug>`) and feeds it through the Phase 2 `compileCandidate` pipeline — the resulting shadow organism is structurally identical to a miner-born one (status=shadow, fitness zeroed, kin-seedable, promotable). Dedup uses `organismIdOf(b) = sha256(${nameSuggestion}:v1)[0..8]` → `orgm-<hex>`, matching `skillCompiler.makeOrganismId` byte-for-byte so `existsSync(getOrganismDir('shadow', id))` catches prior seeds. Per-entry outcomes: `seeded` (fresh compile) / `skipped` (already exists, no --force) / `planned` (dry-run) / `filtered` (cut by include/exclude; when both are present include picks the candidate set and exclude trims further inside it). `isWarmstartWriteEnabled()` env precedence: explicit `CLAUDE_EVOLVE_WARMSTART=on|off` wins, fallback to `CLAUDE_EVOLVE=off` (safety override), otherwise default on — warmstart writes only touch `shadow/`, and `--dry-run` still audits without any gate. Two mutually-exclusive modes: `--list [--tags tag1,tag2]` (always read-only, always available) prints aligned `slug / kind / tags / pitch` table with total-count header and a `hint: --seed` trailer, `--tags` filters to baselines whose tags include any listed value; `--seed [--include slug1,slug2] [--exclude slug3] [--dry-run] [--force]` synthesizes to shadow/ printing per-entry rows tagged `✓ seeded` / `✎ planned` / `· skipped` / `— filtered` + count header + `next: /evolve-status // /evolve-lineage` hint when organisms were written. Parser enforces: exactly one mode flag, csv-value flags reject empty lists, unknown flags surface USAGE. `--dry-run` is treated as pure-read and **bypasses** the gate so operators can preview plans even with evolution fully gated off (onboarding safety). Registered in `commands.ts` right after `evolveLineage`. |
| Joint Tuning Coordinator | `services/autoEvolve/oracle/jointTuningCoordinator.ts` | **Phase 36** — Phase 24 + Phase 27 联合调优协调器。核心问题:两个 tuner 都吃同一条 `fitness.ndjson` 但从不同角度提建议,而 `computeWeightSuggestion` 内部 `loadTunedThresholds()` 用阈值给 SNR 分桶 —— 意味着阈值一旦单独 apply,下一次 meta 建议的输入底基就变了,两次连 apply 后下一窗口的 fitness 分布是两个变量一起移的结果,归因困难,严重时震荡。`planJointTuning(windowDays?)` 一口气调用 `computeTuningSuggestion` + `computeWeightSuggestion`(后者用 current thresholds 作快照),产出单一 `JointTuningPlan` 含两边的 suggestion、`thresholdReady` / `weightReady` / `bothReady` 布尔、norm/max 度量、`interaction: 'both-insufficient' \| 'threshold-only' \| 'weights-only' \| 'cooperative' \| 'big-shake'` 分类、以及推荐的 `ApplyStrategy`。**就绪门槛**:`THRESHOLD_MIN_EFFECTIVE_DELTA=0.01` / `WEIGHT_MIN_EFFECTIVE_DELTA=0.02`(低于此值视为噪声,即使样本够也算 not-ready,防止抖动触发联合调优);**big 门槛**:`THRESHOLD_BIG_SINGLE=0.1` / `THRESHOLD_BIG_NORM=0.15` / `WEIGHT_BIG_SINGLE=0.05` / `WEIGHT_BIG_NORM=0.08` —— 两边都 ready 时再看 delta 是否大,两边都大或任一边大 = `big-shake`,需要 damping,否则 `cooperative` 直接叠加。`applyJointTuningPlan(plan)` 按 strategy 写盘,关键**先阈值后权重**:`thresholds-then-weights(-damped)` 分支先 `saveTunedThresholds(...)`,再**重算** `computeWeightSuggestion(windowDays)` —— 因为 metaEvolver 内部的 `loadTunedThresholds` 现在看到的是新阈值,旧 suggestion 已经 stale;重算后若 insufficient(例如阈值收紧后 win+loss 样本都 <`MIN_SAMPLES_FOR_META=20`),`actualStrategy` 优雅降级为 `thresholds-only`(联合协调器永不硬塞坏 weight)。`big-shake` 分支对重算后的 suggestion 走 `dampFactor=DEFAULT_DAMP_FACTOR=0.5` damping:`damped_i = current_i + 0.5 * (suggested_i - current_i)`,对 4 维分别 clamp 到 `[WEIGHT_MIN=0.05, WEIGHT_MAX=0.7]`,再归一化到 sum=1,最后加 `version=1 + updatedAt` 落盘。返回的 `ApplyJointResult.dampedWeights: Array<{name, raw, damped}>` 是每维的 damping 审计 trace,供命令层输出给 reviewer。`isJointTuneWriteEnabled()` 三级 env 优先:显式 `CLAUDE_EVOLVE_JOINT=on\|off` 最强;否则看 `CLAUDE_EVOLVE_TUNE` + `CLAUDE_EVOLVE_META` **都** on 才放行(单边 on 不够,避免偷偷跨过另一边的 refusal);再回退到 `CLAUDE_EVOLVE=on` 兜底;**默认 off** —— 联合写入 blast radius 比单边大,保守默认和 `/evolve-tick` 一致。本模块自身不做 gate —— gate 判断在命令层。 |
| /evolve-tune-joint | `commands/evolve-tune-joint/index.ts` | **Phase 36** — reviewer entry to `jointTuningCoordinator`. Hidden command parsing `[--window N] [--apply] [--reset --confirm]`,`--window` 限 1..3650(整数),默认 30;三个动作两两互斥(`--apply` 和 `--reset` 同时出现直接 parse error)。**Dry-run(默认)** 永远只读:打印 `## autoEvolve Joint Tuning — Phase 36` 标题行,紧跟 `window / interaction / strategy / damp` 单行摘要,然后两个对齐表 —— `### thresholds (Phase 24)` 列 `dataPoints / positives / negatives / insufficient`,若有 rows 再列 `name / current / suggested / delta / rationale`(delta 带 ±号、3 位小数),配脚注 `norms: deltaNorm=... deltaMax=... ready=...`;`### oracle weights (Phase 27)` 同构外加 `snr` 列;最后 `### plan notes` 区块逐行列出分类理由(例如 `thresholds: BIG (max |delta|=0.30, norm=0.10)` / `decision: thresholds-then-weights-damped (damp=0.50) — both sides moving fast, damp weight side to avoid overshoot`)。尾部 `hint:` 行提示 `--apply`。**`--apply`** 先跑 `isJointTuneWriteEnabled()` gate,未放行时打印 `attempted: false  \|  reason: env gate is off` + 具体需要哪个 env,一行不落盘;gate 开时 `applyJointTuningPlan(plan)` 执行,在 dry-run 表后追加 `### apply result` 区块(`actualStrategy` 行 + `wroteThresholds=... wroteWeights=...` 标志 + 每条 note + `damped weights (raw → damped)` 子表若 damping 被触发)。**`--reset --confirm`** 在 gate 开时 `rmSync` 掉 `tuned-thresholds.json` + `tuned-oracle-weights.json`(任一不存在就跳过,`not present`),回归 `DEFAULT_TUNED_THRESHOLDS` + `DEFAULT_TUNED_ORACLE_WEIGHTS`;缺 `--confirm` 直接拒绝;gate off 走相同 `attempted: false` 提示。Parse guards 拒 `--apply --reset` / 未知 flag / `--window` 缺值 / `--window` 非整数 / `--window` 超范围。Registered in `commands.ts` right after `evolveWarmstart`. |
| Promotion Threshold Tuner | `services/autoEvolve/emergence/promotionThresholdTuner.ts` | **Phase 37** — autoPromotionEngine tier 阈值的自调节器。靶子是原硬编码 `SHADOW_TO_CANARY_MIN_INVOCATIONS=3` / `SHADOW_TO_CANARY_MIN_AGE_DAYS=1` / `CANARY_TO_STABLE_MIN_INVOCATIONS=10` / `CANARY_TO_STABLE_MIN_AGE_DAYS=3` —— 长期看,这组值太紧会让真正好的 organism 晋升迟,太松又会让一批 shadow/canary 被晋升后又被 vetoed(回归)。Phase 37 把这 4 个常量抽出成 `TunedPromotionThresholds { version:1, updatedAt, shadowToCanaryMinInvocations, shadowToCanaryMinAgeDays, canaryToStableMinInvocations, canaryToStableMinAgeDays }`,落在 `oracle/tuned-promotion-thresholds.json`(见新 path helper `getTunedPromotionThresholdsPath`),`DEFAULT_TUNED_PROMOTION_THRESHOLDS` 的数值字段 ≡ 原硬编码,文件缺失 → load fallback → 行为不变,完全向后兼容。**信号来源**:`readAllTransitions()` 读 `oracle/promotions.ndjson` 全量 Transition,按 `(from,to)` 分桶 `shadow→canary` / `canary→stable`,对每个桶 `computeTierStats(all, windowMs, from, to) → {promotedIds, regressedIds}` —— promotion 事件必须落在 `[now-windowDays*86400_000, now]` 内;同一 organism 重复晋升取最早时间;**regressionRate** 分母是窗口内晋升数,分子是"晋升之后"(`transition.at >= promotedAt`)出现 `to='vetoed'` 的 organism 数。只数 `vetoed`、不数 `archived`,因为 archived 两义(stable 的正常退役 vs shadow/canary 的 auto-age 超时),会污染"回归率"语义。**决策规则**:`decideRow(name, current, regressionRate, total, field)` —— `regressionRate ≥ HIGH_REGRESSION_RATE=0.3` → tighten +1;`regressionRate ≤ LOW_REGRESSION_RATE=0.05` AND `total ≥ MIN_SAMPLES_RELAX=5` → relax -1;其它 → hold,保持 current。建议值全部 `clamp` 到 `[INVOCATIONS_MIN=1, INVOCATIONS_MAX=50]` 或 `[AGE_DAYS_MIN=0, AGE_DAYS_MAX=30]`,一次 ±1 的保守步长避免过度调参。全局样本门槛 `MIN_SAMPLES_FOR_PROMO_TUNE=5`,总晋升 <5 直接 insufficient,不出 rows,避免早期噪声误触发。**API**:`loadTunedPromotionThresholds()` 带 mtime 缓存(autoPromotionEngine 热路径读,不拖慢 evaluate);`saveTunedPromotionThresholds(t)` 写完立即清缓存;`computePromotionTuningSuggestion(windowDays=30) → PromotionTuningSuggestion { windowDays, totalTransitions, shadowToCanaryCount/Regressed, canaryToStableCount/Regressed, insufficientReason, rows[] }`;`suggestionToNext(s)` 保留未在 rows 出现的 tier-field(只有某 tier 有数据时另一 tier 原值不动);`_resetTunedPromotionThresholdsCacheForTest()` 供测试用。`autoPromotionEngine.decide` 在 Phase 7 favorable 判定之后立刻 `const tuned = loadTunedPromotionThresholds()`,用 `tuned.shadowToCanaryMinInvocations` / `.shadowToCanaryMinAgeDays` / `.canaryToStableMinInvocations` / `.canaryToStableMinAgeDays` 替换原硬编码引用(同时保留 `export const` 供外部引用,向后兼容)。|
| /evolve-tune-promotion | `commands/evolve-tune-promotion/index.ts` | **Phase 37** — reviewer entry to `promotionThresholdTuner`. Hidden command 解析 `[--apply \| -a] [--window \| -w DAYS] [--reset]`,`--window` 整数 1..365(默认 30),`--apply` 和 `--reset` 互斥(`parseFlags` 直接 error);支持 `--help` / `-h` 打印 USAGE。**Dry-run(默认)**永远只读:打印 `## autoEvolve Promotion Threshold Auto-Tuner (Phase 37)` 标题,紧跟 `mode: dry-run (no write)` / `window: last N day(s)` / `total transitions in ledger: N` 头部三行;然后两行统计 `shadow→canary: promoted=X  regressed(vetoed)=Y  rate=Z.ZZZ`(count=0 时省略 rate 行)和同构 `canary→stable` 行;若 `suggestion.insufficientReason` 非空,追加 `!! insufficient data: <reason>` 告警块 + `nothing to apply` 提示;若有 rows,`Suggestion:` 区块渲染对齐表 `name / current / suggested / delta`(delta 带 `(unchanged)` / `+N` / `-N`),后跟 `Rationale:` 区块逐行列出 decideRow 理由(如 `tighten: regressionRate=0.600 ≥ 0.30 (n=5) → +1`、`relax: regressionRate=0.000 ≤ 0.05 (n=10 ≥ 5) → -1`、`hold: regressionRate=0.100 in [0.05, 0.30) (n=10)`);尾部 `To commit these values: re-run with --apply` / `To wipe: --reset` 提示。**`--apply`**:insufficient 时打印 `--apply skipped due to insufficient data` 提示,已有 tuned 文件不动(避免用户手改被覆盖成 default);否则 `suggestionToNext` + `saveTunedPromotionThresholds`,追加 `Apply result:` 区块(`wrote <path>` / `updatedAt` / `new values: shadow→canary inv=... age=...d, canary→stable inv=... age=...d` / `autoPromotionEngine will pick up new values on next evaluate (mtime cache)`);写失败捕获 `Error` 并打印 `!! write failed`。**`--reset`**:不存在 → `no tuned-promotion-thresholds.json at ...; nothing to reset` + `already using DEFAULT (3/1/10/3)` 说明;存在 → `unlinkSync` + 清缓存 + `removed <path>` + `will fall back to DEFAULT on next evaluate`;删除失败打印 `unlink failed` 和路径。Parse guards 拒 `--apply --reset` / 未知 flag / `--window` 缺值(`requires a number`)/ `--window` 非正整数或越界(`must be a positive integer 1..365`)。不设 env gate —— tuner 只写 `oracle/tuned-promotion-thresholds.json` 一个文件,blast radius 仅限自家 tier 阈值,不需要和 `/evolve-tune-joint` 那种跨模块级 gate。Registered in `commands.ts` right after `evolveTuneJoint`. |
| Archive Threshold Tuner | `services/autoEvolve/emergence/archiveThresholdTuner.ts` | **Phase 38** — autoArchiveEngine 的 `STALE_STABLE_UNUSED_DAYS=45` / `STALE_STABLE_MIN_AGE_DAYS=14` 自调节器,关闭 Phase 14 candidate 的剩余一半。抽出为 `TunedArchiveThresholds { version:1, updatedAt, staleStableUnusedDays, staleStableMinAgeDays }`,落在 `oracle/tuned-archive-thresholds.json`(新 path helper `getTunedArchiveThresholdsPath`);`DEFAULT_TUNED_ARCHIVE_THRESHOLDS` 数值 ≡ 原硬编码(45/14),文件缺失 → load fallback → 行为不变。**信号源创新点**:`promotionFsm.ts` 把 `archived` 设为终态(`archived → ∅`),FSM 不允许"复活",所以靠"archived→resurrected"当信号恒为 0;转而解析 autoArchiveEngine 写在 Transition.rationale 里的 dsli —— rationale 固定格式 `"auto-stale: no invocation for {dsli}d (lastInvokedAt=..., threshold=Xd, age=Yd)"`,`parseDsliFromRationale(s)` 用 `/no invocation for (\d+\.?\d*)d/` 抽数值,失败返回 null(跳过这条样本,不污染统计)。**分桶**:窗口内所有 `trigger='auto-stale'` 事件的 dsli 按 `current.staleStableUnusedDays` 分三桶 —— `borderline` = `0 < dsli ≤ threshold * (1 + BORDERLINE_MARGIN=0.2)`(刚过线,阈值嫌紧,有回流潜力);`longAbandoned` = `dsli ≥ threshold * LONG_ABANDON_MARGIN=2.0`(早已躺尸,阈值嫌松);中间区间 healthy。**决策规则**:`borderlineRate ≥ HIGH_BORDERLINE_RATE=0.4` → relax(UNUSED +UNUSED_STEP=5, MIN_AGE +MIN_AGE_STEP=2);`longAbandonedRate ≥ HIGH_ABANDONED_RATE=0.6` → tighten(-5/-2);其它 hold。步长比 Phase 37 的 ±1 大,因为 45d 的 ±1 变化小于噪声,±5/±2 保证"每次调整都能看见效果"。全部 clamp 到 `[UNUSED_DAYS_MIN=7, UNUSED_DAYS_MAX=365]` / `[MIN_AGE_DAYS_MIN=1, MIN_AGE_DAYS_MAX=90]`。**insufficient 门槛**:`parsedCount < MIN_SAMPLES_ARCHIVE_TUNE=5` 返回空 rows + reason,防止早期噪声。**API**:`loadTunedArchiveThresholds()` mtime 缓存(autoArchiveEngine `decideByStale` 热路径调用);`saveTunedArchiveThresholds(t)` 写盘即清缓存;`computeArchiveTuningSuggestion(windowDays=30) → ArchiveTuningSuggestion { windowDays, totalTransitions, autoStaleCount, parsedCount, borderlineCount, longAbandonedCount, insufficientReason, rows[] }`;`suggestionToNext(s)` 保留未在 rows 的字段(只有某字段有 row 时另一字段原值不动);`parseDsliFromRationale(s) → number\|null`;`_resetTunedArchiveThresholdsCacheForTest()` 供测试用。`autoArchiveEngine.decideByStale` 在 age/dsli 计算后立刻 `const tuned = loadTunedArchiveThresholds()`,用 `tuned.staleStableMinAgeDays` / `tuned.staleStableUnusedDays` 替换原硬编码引用,同时 rationale 里的 `threshold=Xd` 也随 tuned 值变 —— 形成 **self-calibrating 闭环**:新归档事件写入的 dsli / threshold 比例会被下一轮 tuner 读到,继续收紧/放宽。`export const STALE_STABLE_UNUSED_DAYS/MIN_AGE_DAYS` 继续导出以便外部 inspect 或 fallback 判定。`decideByStale` 本身也 `export` 了(Phase 38 后公开,便于验证层直接喂 manifest 测试 tuned 传参)。|
| /evolve-tune-archive | `commands/evolve-tune-archive/index.ts` | **Phase 38** — reviewer entry to `archiveThresholdTuner`. Hidden command 解析 `[--apply \| -a] [--window \| -w DAYS] [--reset]`,与 `/evolve-tune-promotion` 同构:`--window` 整数 1..365(默认 30),`--apply` 和 `--reset` 互斥,`--help`/`-h` 打印 USAGE。**Dry-run(默认)**永远只读:打印 `## autoEvolve Archive Threshold Auto-Tuner (Phase 38)` 标题,紧跟 `mode: dry-run (no write)` / `window: last N day(s)` / `total transitions in ledger: N` 头部三行;然后 `auto-stale events (in window): N  dsli-parsed: M` 统计行;若 `parsedCount > 0`,追加 `borderline(dsli≤thr·1.2): X  rate=R.RRR` 和 `longAbandoned(dsli≥thr·2): X  rate=R.RRR` 两行;insufficient 时追加 `!! insufficient data: <reason>` 告警 + `nothing to apply` 提示;若有 rows,`Suggestion:` 区块对齐表 `name / current / suggested / delta`(delta 带 `(unchanged)` / `+N` / `-N`),后跟 `Rationale:` 逐行列出理由(如 `relax: borderlineRate=0.800 ≥ 0.40 (n=5) → +5`、`tighten: longAbandonedRate=1.000 ≥ 0.60 (n=5) → -5`、`hold: borderlineRate=0.000 longAbandonedRate=0.000 (n=5)`);尾部 `--apply` / `--reset` 提示。**`--apply`**:insufficient 时跳过已有文件(避免误覆盖);就绪则 `suggestionToNext` + `saveTunedArchiveThresholds`,追加 `Apply result:`(`wrote <path>` / `updatedAt` / `new values: unused=Nd  minAge=Md` / `will pick up new values on next evaluate (mtime cache)`);写失败捕获 `Error` 并打印 `!! write failed`。**`--reset`**:不存在 → `no tuned-archive-thresholds.json at ...; nothing to reset` + `already using DEFAULT (45/14)`;存在 → `unlinkSync` + 清缓存 + `removed <path>` + `will fall back to DEFAULT on next evaluate`;删除失败打印 `unlink failed` 和路径。Parse guards 与 /evolve-tune-promotion 共同口径。不设 env gate —— tuner 只写 `oracle/tuned-archive-thresholds.json` 一个文件,blast radius 仅限自家 archive 阈值。Registered in `commands.ts` right after `evolveTunePromotion`. |
| Oracle Decay Tuner | `services/autoEvolve/oracle/oracleDecayTuner.ts` | **Phase 39** — oracleAggregator 聚合权重的时间衰减自调节器。靶子是 `aggregateOrganismFitness` / `aggregateAllOrganisms` 的算术平均 —— 所有 `FitnessScore` 不论 `scoredAt` 远近同权,几个月前的 session 把 `manifest.fitness.avg` 锁死,`autoPromotionEngine` adverse-veto 无法触发;反向也成立,一条早年 loss 样本会持续拉低"刚刚起色"的 shadow。Phase 39 引入 **指数半衰期权重**:`weight(score) = 0.5 ^ ((now - scoredAt) / halfLifeDays)`、`weightedAvg = Σ(score·weight) / Σ(weight)`,抽出 `TunedOracleDecay { version:1, updatedAt, halfLifeDays }`,落在 `oracle/tuned-oracle-decay.json`(新 path helper `getTunedOracleDecayPath`)。**向后兼容关键**:不同于 Phase 24/37/38 的 DEFAULT = 原硬编码生效值,Phase 39 没有"原值"可对齐 —— `DEFAULT_TUNED_ORACLE_DECAY.halfLifeDays = 0` 是 **sentinel**:文件缺失 → load fallback → `decayWeight ≡ 1` → aggregator 退化为算术平均,100% 等同 Phase 1-38,零行为变更;用户 opt-in 的唯一路径是 `/evolve-tune-oracle-decay --apply` 写入正值。**信号源**:`recentFitnessScores(windowSamples)` 读 `fitness.ndjson`,对每条算 `age = (now - scoredAt)/86400_000`,取 **p75 age**(75 分位,nearest-rank),除以 current halfLife 得 `ratio`。**决策规则**:`current=0` 时走 first-opt-in(`p75Age ≥ MIN_P75_AGE_FOR_FIRST_OPT_IN=14d` → `suggested = round_to_step(p75)`,否则 hold 并打印 `samples too fresh`);`current>0` 时 `ratio ≥ HIGH_RATIO=2.0` → relax +HALF_LIFE_STEP=15(老样本过快消失,加大半衰期);`ratio ≤ LOW_RATIO=0.3` → tighten -15(老样本几乎不衰减,缩小);中间 hold。全部 clamp 到 `[HALF_LIFE_MIN=7, HALF_LIFE_MAX=365]`,`clampAndStep(v)` 把建议值对齐到 15 的整数倍(步长比 Phase 37 的 ±1 大,因为 halfLife 量级本身大,±1 小于噪声)。全局样本门槛 `MIN_SAMPLES_DECAY_TUNE=10`,<10 直接 insufficient,不出 rows。**decayWeight 防守语义**:`halfLifeDays ≤ 0 → 1`(sentinel/bad)、`Date.parse 失败 → 1`(坏 ISO)、`age ≤ 0 → 1`(未来时间戳)—— 这是 aggregator 热路径,必须无异常也不强行衰减坏数据。**API**:`loadTunedOracleDecay()` 带 mtime 缓存 + 防御 schema 校验(version≠1/halfLifeDays 非数/负值都回退 DEFAULT 并 `logForDebugging`);`saveTunedOracleDecay(t)` `mkdirSync recursive` 后原子写 + 清缓存;`decayWeight(scoredAtIso, halfLifeDays, nowMs?)`(`nowMs` 参数留给测试注入 deterministic now);`computeQuantiles(ageDays) → {p25,p50,p75}`(sample<2 返回全 0);`clampAndStep(v)`;`computeOracleDecayTuningSuggestion(windowSamples=500) → OracleDecayTuningSuggestion { windowSampleCount, p25/50/75AgeDays, currentHalfLife, insufficientReason, rows[] }`;`suggestionToNext(s)` 保留未出现在 rows 的字段(Phase 39 只有 halfLifeDays 一行);`_resetTunedOracleDecayCacheForTest()`。**aggregator 接线**:`aggregateOrganismFitness` 把累加器由 `sum/lastAt` 改为 `weightedSum + weightSum`,循环开始前 `const decay = loadTunedOracleDecay()`,对每条 hit 样本 `const w = decayWeight(s.scoredAt, decay.halfLifeDays); weightedSum += s.score*w; weightSum += w`,最终 `avg = weightSum > 0 ? weightedSum/weightSum : 0`。`aggregateAllOrganisms` 同构,但 weight **每条 score 只算一次**(不是 per-hit organism)—— 当一条 score 同时命中多个 organism(`organismId` + `sessionSet` union),共享同一份 weight 避免按命中 organism 数被放大。**bucket counts 保持整数**:`wins/losses/neutrals/trials` 不受 decay 影响(仍按整条样本计数 +1),这样 `autoPromotionEngine.MIN_INVOCATIONS` 对比不会因为 weighted 小于 1 而被破坏,下游兼容性稳定。 |
| /evolve-tune-oracle-decay | `commands/evolve-tune-oracle-decay/index.ts` | **Phase 39** — reviewer entry to `oracleDecayTuner`. Hidden command 解析 `[--apply \| -a] [--window \| -w N] [--reset] [--disable]`,`--window` 整数 1..10000(默认 500,因为 fitness.ndjson 条目比 promotions 稠密);`--apply` / `--reset` / `--disable` 三者两两互斥(`parseFlags` 直接 error);`--help`/`-h` 打印 USAGE。**Dry-run(默认)**永远只读:打印 `## autoEvolve Oracle Decay Auto-Tuner (Phase 39)` 标题,紧跟 `mode: dry-run (no write)` / `sample window: last N score(s)` / `actual count: N` / `current halfLifeDays: Nd`(`current=0` 时追加 `(sentinel: decay OFF)` 标记);若 `windowSampleCount > 0`,追加 `sample age p25=X.Xd  p50=X.Xd  p75=X.Xd` 统计行;insufficient 时追加 `!! insufficient data: <reason>` + `nothing to apply; existing tuned file (if any) untouched`;若有 rows,`Suggestion:` 区块对齐表 `name / current / suggested / delta`(delta 带 `(unchanged)` / `+N` / `-N`),后跟 `Rationale:` 逐行列出理由(如 `first opt-in: p75Age=45.0d ≥ 14d → halfLife=45d`、`relax: ratio=2.500 ≥ 2.00 (p75=75.0d, halfLife=30d) → +15`、`tighten: ratio=0.200 ≤ 0.30 (p75=6.0d, halfLife=30d) → -15`、`hold: ratio=0.800 in (0.30, 2.00) (p75=24.0d, halfLife=30d)`);尾部三个提示 `--apply` / `--disable`(opt-out 保留审计)/ `--reset`(wipe 文件)。**`--apply`**:insufficient 时显式打印 `--apply skipped due to insufficient data; existing tuned-oracle-decay.json (if any) is untouched`(保护用户手改不被覆盖);就绪则 `suggestionToNext` + `saveTunedOracleDecay`,追加 `Apply result:`(`wrote <path>` / `updatedAt` / `new halfLifeDays: Nd` / `oracleAggregator will pick up new weighting on next aggregate (mtime cache)`);写失败捕获 `Error` 并打印 `!! write failed`。**`--disable`**:显式 opt-out 路径,写入 `halfLifeDays=0` 但 **保留文件作为审计记录**(区分"用户主动关"和"从未触碰"两种状态)—— 打印 `## autoEvolve Oracle Decay Auto-Tuner — Disable (Phase 39)` + `wrote halfLifeDays=0 to <path>` + `time-decay is now explicitly OFF; oracleAggregator uses arithmetic mean again` + `audit: file kept (not deleted) so "explicit opt-out" is distinguishable from "never touched". Run --reset to wipe`。**`--reset`**:文件不存在 → `no tuned-oracle-decay.json at ...; nothing to reset` + `already using DEFAULT (halfLifeDays=0, feature off)`;存在 → `unlinkSync` + 清缓存 + `removed <path>` + `will fall back to DEFAULT sentinel (halfLifeDays=0) on next aggregate`;删除失败打印 `unlink failed` + 路径。Parse guards 拒 `--apply --reset` / `--apply --disable` / `--disable --reset` 任一组合、未知 flag、`--window` 缺值 / 非正整数 / 越界(`1..10000`)。不设 env gate —— tuner 只写 `oracle/tuned-oracle-decay.json` 一个文件,且 sentinel 设计保证"从未 --apply 过的环境完全不受 Phase 39 影响",blast radius 极小。Registered in `commands.ts` right after `evolveTuneArchive`. |
| Rollback Watchdog | `services/autoEvolve/emergence/rollbackWatchdog.ts` | **Phase 40** — canary/stable → shadow 反向降级闸门。痛点:autoPromotionEngine 是前向 FSM(shadow→canary→stable),`canary`/`stable` 晋升后若 Phase 39 weighted `fitness.avg` 回落,当前只有 autoArchiveEngine 基于"时间不用"触发 auto-stale,不会基于"分数差"做降级,后果是晋升失败的 organism 长期污染 aggregate 和 Oracle 分布。Phase 40 在 `promotionFsm.ALLOWED` 表加 **反向边** `canary → shadow` 和 `stable → shadow`(types.ts 同步扩展 `TransitionTrigger` 加 `'auto-rollback'`),新模块 rollbackWatchdog 扫 canary+stable 两层,用 `aggregateOrganismFitness(id)` 拿 Phase 39 weighted avg 做降级判断。**降级到 shadow 不到 vetoed 的纪律**:shadow 是观察位,保留 `invocationCount/fitness` 累积数据,给 organism 第二次自然晋升通道(后续数据回暖会 canary→stable);shadow 阶段持续拉胯会被既有 `shadow→vetoed` 路径吸收,不重复造轮子。**三重门槛(任一不满足 hold)**:canary — `ROLLBACK_CANARY_AVG_MAX=-0.3`(与 Phase 7 `ORGANISM_LOSS_THRESHOLD` 对齐)/ `MIN_TRIALS=3` / `MIN_AGE_DAYS=3`;stable — 更严,`AVG_MAX=-0.2`(stable 已证明过自己,要更大证据强度)/ `MIN_TRIALS=5` / `MIN_AGE_DAYS=7`。晋升时间戳从 `promotions.ndjson` 倒查最后一条 `to=<status>` 的 Transition(不依赖 readRecentTransitions 的排序方向,直接 max(Date.parse(t.at)) 更鲁棒);读不到回退到 `manifest.fitness.lastTrialAt`(保守地把最近一次 fitness 事件当晋升时刻代理,至少保证 MIN_AGE_DAYS 不会永远 satisfies)。**API**:`findLastPromotionAt(id, toStatus, limit=2000)` → `string\|null`;`evaluateRollback(manifest, aggregate, nowMs=Date.now()) → RollbackEvaluation \| null`(shadow/proposal/vetoed/archived 全返 null,不关心非晋升态);`scanRollbackCandidates({nowMs?}) → RollbackScanResult { scannedCanary, scannedStable, rollbackCount, holdCount, evaluations[] }`(纯读:listOrganismIds+readOrganism+aggregateOrganismFitness);`applyRollback(evaluation)` → 走 `promoteOrganism({from, to:'shadow', trigger:'auto-rollback', rationale, oracleScoreSignature: aggregate.lastScoreSignature})`(透传最后一次打分签名做审计闭环)。**rationale 语义**:rollback 走 `auto-rollback (Phase 40): weighted avg=X ≤ T, trials=N ≥ M, ageSincePromotion=Dd ≥ MIN_AGE_DAYSd`,hold 走 `hold (Phase 40): <reason1>; <reason2>`(原因可多条同列,便于 reviewer 一眼看出是哪个门槛拦的)。**与 Phase 38 archive watchdog 的互补**:Phase 38 管"活但不被用"(time signal→stale),Phase 40 管"被用但得分差"(fitness signal→rollback)—— 两者加上既有 shadow→vetoed 串成完整闭环,任何失能 organism 最终都能收敛到终态。**Phase 41 runtime**:`evaluateRollback` 开头已改为 `const tuned = loadTunedRollbackThresholds(); const thresholds = status==='canary' ? tuned.canary : tuned.stable`,Phase 40 的 `ROLLBACK_CANARY_*` / `ROLLBACK_STABLE_*` 常量仍 `export` 保留向后兼容,但实际判定走 tuned 文件(缺失回退 DEFAULT = Phase 40 硬编码值,行为等价);rationale 里的 `thr{...}` 也随 tuned 值变。 |
| /evolve-rollback-check | `commands/evolve-rollback-check/index.ts` | **Phase 40** — reviewer/cron 入口。Hidden command 解析 `[--apply \| -a] [--limit \| -l N]`;`--limit` 整数 1..500 默认 20,只截断输出行数(scan 始终全量)。**Dry-run(默认)**:打印 `## autoEvolve Promotion Rollback Watchdog (Phase 40)` 标题,`mode: dry-run (no write)` / `scanned: canary=N stable=M` / `decisions: rollback=X hold=Y` 头部;若 `evaluations.length===0` 打印 `(no canary/stable organisms to evaluate)` 提前返回;否则按 `decision=rollback` 优先 + 组内按 `avg` 升序(最差的在最上面)排序,truncate 到 `--limit`,逐条打印 `N. [ROLLBACK/HOLD] status/name (id)` + `avg=X trials=N age=Dd  thr{avg≤T, trials≥M, age≥Kd}` + `rationale: ...`;末尾 `To execute rollback...: re-run with --apply`。**`--apply`**:扫一遍 evaluations,对 `decision=rollback` 调 `applyRollback(ev)`,逐条打印 `✓ canary→shadow: name (id)` 或 `✗ ... — <reason>`;末尾 `applied=X failed=Y`。不设 env gate —— dry-run 无副作用,`--apply` 每条 rollback 都走 FSM signed transition,失败捕获到行文本,不抛异常。Parse guards 拒未知 flag、`--limit` 缺值/非正整数/越界(`1..500`)。Registered in `commands.ts` right after `evolveTuneOracleDecay`. |
| Rollback Threshold Tuner | `services/autoEvolve/oracle/rollbackThresholdTuner.ts` | **Phase 41** — Phase 40 rollbackWatchdog 6 个硬编码阈值(canary/stable 各 `avgMax/minTrials/minAgeDays`)的自调节器,对应 Phase 40 DONE 尾巴里承诺的"先观察再抽 tuner"。抽成 `TunedRollbackThresholds { version:1, updatedAt, canary{avgMax, minTrials, minAgeDays}, stable{avgMax, minTrials, minAgeDays} }` 落在 `oracle/tuned-rollback-thresholds.json`(见 `getTunedRollbackThresholdsPath`),`DEFAULT_TUNED_ROLLBACK_THRESHOLDS` 数值 ≡ Phase 40 硬编码(-0.3/3/3d 和 -0.2/5/7d),文件缺失 → load fallback → 行为不变。**双路信号**:**FP rate**(误降级)—— `computeFpSignal({rollbackTransitions, fitnessScores, nowMs, observationWindowDays=14})`,扫 `trigger='auto-rollback'` 的 transition,在 `[rollbackAt, rollbackAt+14d]` 窗口找该 organismId 的 FitnessScore,若 `avg(score) > 0` 则该 event 记为 FP(rollback 后本应低迷却迅速回暖),观察窗口未满(`now < rollbackAt + 14d`)的 event 跳过不计,保证统计的 FP 都有足够证据时间;**FN rate**(漏降级)—— `computeFnSignal({evaluations})`,读 `scanRollbackCandidates()` 当前 decisions,`decision='hold'` 且 `avg ≤ thresholds.avgMax` 但 trials/age 门槛拦下(reasons 含 `trials < N` 或 `ageSincePromotion < Kd`)的组织算 FN 候选,同 status 全部 hold 为分母。**决策**:`computeRollbackThresholdTuningSuggestion({currentTuned, rollbackTransitions, fitnessScores, evaluations})` 对 canary/stable 各自独立 —— 样本 `< MIN_SAMPLES_TO_TUNE=5` → `insufficient`(next===current);`fpRate ≥ 0.5 AND fnRate < 0.3` → **tighten**(avgMax -=0.05, minTrials +=1, minAgeDays +=1);`fpRate ≤ 0.1 AND fnRate ≥ 0.3` → **relax**(avgMax +=0.05, -1, -1);其它 hold。步长**故意极小**(avgMax ±0.05,trials/age ±1),避免单次 tuning 过度偏移,连续跑能逐步逼近最优;clamp `avgMax∈[-0.7,-0.05]` × `minTrials∈[1,20]` × `minAgeDays∈[1,30]` 确保 runaway 下也不退化到荒谬值。**API**:`loadTunedRollbackThresholds()` mtime 缓存 + schema 校验(`version≠1` / 数值域外 / NaN → fallback DEFAULT 不覆盖);`saveTunedRollbackThresholds(t)` 自动 clamp 再写 + 清缓存(写异常不污染热路径);`clearTunedRollbackThresholdsCache()` 供 `--reset` 清理外部 `unlink` 后的缓存。**rollbackWatchdog 接线**:`evaluateRollback` 开头立刻 `const tuned = loadTunedRollbackThresholds(); const thresholds = status==='canary' ? tuned.canary : tuned.stable`,替换 Phase 40 的硬编码 `ROLLBACK_CANARY_*` / `ROLLBACK_STABLE_*` 引用(`export const` 保留向后兼容);rationale 输出里的 `thr{avg≤T, trials≥N, age≥Kd}` 也随 tuned 值变 —— 形成 **self-calibrating 闭环**:下一轮 tuner 读到的 rollback event 上下文已是新阈值,继续收紧/放宽。**与 Phase 24/27/37/38/39 的分工**:Phase 24 oracle 阈值(win/loss/adverse/perfect 离散);Phase 27 Oracle 权重(SNR-based 连续);Phase 37 promotion tier 阈值(shadow→canary→stable 离散);Phase 38 auto-stale 阈值(stable→archived 时间离散);Phase 39 oracleAggregator halfLife(aggregator 连续加权);Phase 41 rollback 阈值(canary/stable→shadow fitness 离散) —— 六个 tuner 职责清晰分片,各写独立 `tuned-*.json`,mtime-cached 互不打架。|
| /evolve-tune-rollback-thresholds | `commands/evolve-tune-rollback-thresholds/index.ts` | **Phase 41** — reviewer/cron 入口。Hidden command 解析 `[--apply \| -a] [--reset] [--limit \| -l N]`;`--limit` 整数 1..20000 默认 5000(transitions 和 fitness 共用窗口);`--apply` / `--reset` 互斥(`parseFlags` 直接 error);`--help`/`-h` 打印 USAGE。**Dry-run(默认)** 永远只读:打印 `## autoEvolve Rollback Threshold Auto-Tuner (Phase 41)` 标题、`mode: dry-run (no write)` / `data window: transitions=X (limit=L), fitnessScores=Y (limit=L)` / `current scan: canary=... stable=... (rollback=... hold=...)` 头部三行;`Current tuned file:` 区块列当前 canary/stable 六个字段 + updatedAt;`Suggestion:` 区块对齐渲染两个 band —— 每个 band `[CANARY/STABLE]  decision=...` 单行 + `signals: rollbackSamples=X  fpCount=Y  fpRate=Z.ZZ  fnCandidates=W  fnRate=V.VV` 单行 + 三行 `avgMax/minTrials/minAgeDays: X→Y (+N)` delta 带对齐 + 正负号 + `(unchanged)`(避免歧义) + `rationale:` 行说明决策理由(含 fpRate/fnRate/样本数)。末尾按状态给提示:有改动时 `re-run with --apply`;全 insufficient/hold 时 `both insufficient/hold; nothing to apply`;始终提 `--reset` 路径。**`--apply`**:两个 band 都 `insufficient/hold` 时显式打印 `--apply skipped: both bands insufficient/hold; existing tuned-rollback-thresholds.json (if any) is untouched`(保护用户手改不被覆盖);否则 `saveTunedRollbackThresholds(suggestion.nextTuned)`,追加 `Apply result:` 区块(`wrote <path>` / `updatedAt` / 新 canary+stable 字段 / `rollbackWatchdog will pick up new thresholds on next evaluateRollback (mtime cache)`);写失败捕获 `Error` 打印 `!! write failed: <msg>`。**`--reset`**:不存在 → `no tuned-rollback-thresholds.json at ...; nothing to reset` + `rollbackWatchdog is already using Phase 40 DEFAULT (-0.3/3/3d & -0.2/5/7d)`;存在 → `unlinkSync` + `clearTunedRollbackThresholdsCache()` + `removed <path>` + `will fall back to Phase 40 DEFAULT on next evaluate`;删除失败打印 `unlink failed: <msg>` + 路径。**不设 env gate** —— tuner 只写 `oracle/tuned-rollback-thresholds.json` 一个文件,blast radius 仅限 rollback 阈值,sentinel 设计("文件缺失 = Phase 40 DEFAULT")保证从未 `--apply` 过的环境 100% 等同 Phase 40。Parse guards 拒未知 flag、`--limit` 缺值(`--limit requires a number`)/ 非正整数 / 越界(`1..20000`)、`--apply --reset` 互斥(`mutually exclusive`)。Registered in `commands.ts` right after `evolveRollbackCheck`. |

## Lifecycle (Phase 1 + Phase 2 + Phase 4 + Phase 5 + Phase 6 + Phase 7 + Phase 8 + Phase 9 + Phase 10 + Phase 11 + Phase 12 + Phase 13 + Phase 14)

```
feedback_*.md (memdir)
        │
        ▼   minePatterns({ skipCovered: true })
PatternCandidate[]   ← also skips anything listed in oracle/vetoed-ids.json
        │   (not yet covered by any genome manifest)
        ▼   compileCandidates()
~/.claude/autoEvolve/genome/shadow/<id>/
    ├── manifest.json          (OrganismManifest, status='shadow', invocationCount=0,
    │                            expiresAt = createdAt + 30d)
    └── SKILL.md               (frontmatter + review checklist)
        │
        │  manual path:
        │  ── /evolve-accept <id> ──►  canary  ── /evolve-accept <id> ──►  stable
        │  ── /evolve-veto   <id> ──►  vetoed  (terminal; sourceFeedbackMemories
        │                                      remembered for dedup next time)
        │
        │  auto path (Phase 6+7):
        │  ── /evolve-tick --apply ──►  evaluate thresholds per tier ──►
        │     shadow→canary: invocations≥3 AND age≥1d
        │     canary→stable: invocations≥10 AND age≥3d
        │     (held when Oracle recent avg < -0.5 OR CLAUDE_EVOLVE=off)
        │     (Phase 7) per-organism fitness: W<L & trials≥3 → hold,
        │                                    avg≥0.3 & trials≥2 → age×0.5
        │     rationale auto-written = engine reason string; trigger=auto-oracle
        │
        │  auto-age path (Phase 8):
        │  ── /evolve-tick --apply ──►  scan shadow + proposal,
        │     any expiresAt < now ──►  promoteOrganism({to:'archived',
        │                                               trigger:'auto-age'})
        │     rationale = `auto-age: expired Nd past expiresAt=...`
        │     (Oracle macro gate does NOT apply — expiry is an independent fact)
        │
        ▼   On stable promotion:
            addSkillDirectories([genome/stable/])  →  Claude Code skill loader
            picks up every `<id>/SKILL.md` as a prompt-type skill.
            wrapStableSkillsWithInvocationHook() replaces each skill's
            getPromptForCommand with a bump-first wrapper:
              1. recordOrganismInvocation(id) → manifest.invocationCount++
              2. (Phase 7) recordSessionOrganismLink(id) → append
                 { sessionId, organismId, at } to oracle/session-organisms.ndjson
            /evolve-status boot hook (ensureStableGenomeRegistered) covers
            process restarts so existing stable organisms stay discoverable
            AND re-wrapped.

Phase 7 aggregation loop (read-only, side loop):
        fitness.ndjson (subjectId=sessionId)
                          ├──► aggregateOrganismFitness(id) ──►
        session-organisms.ndjson (sessionId↔organismId)     │
                                                             ▼
                          refreshAllOrganismFitness() writes W/L/N/avg
                          back into each manifest.fitness (tmp+rename).
                          Same aggregate feeds the auto-promotion decide()
                          logic AND the /evolve-status stable organism rows.

Phase 9 runtime-loop closure:
  (a) refresh scheduling — refreshAllOrganismFitness() is auto-called at
      two entry points so no manual trigger is required:
        /evolve-status boot  → panel shows live aggregate, not stale snapshot
        applyAutoPromotions  → decide() reads freshest perOrg before gating
      Both call sites swallow errors (panel/promotion must never hard-fail
      on a refresh hiccup).
  (b) TTL re-stamp on promotion — promoteOrganism inserts step 4.5 between
      recordTransition (signed ledger write) and readOrganism (readback):
        toStatus='canary'  → expiresAt = now + CANARY_TTL_DAYS  (60d)
        toStatus='stable'  → expiresAt = null  (immune to auto-age)
        else               → no-op
      Rationale: without this, a just-promoted canary inherits its shadow
      residual TTL and could get archived by auto-age before any real
      canary-tier observation accrues. Failure is logged + swallowed —
      TTL is a soft observation window, not a hard correctness property.

Phase 10 stale-stable harvesting (second scan path of autoArchiveEngine):
        listOrganismIds('stable') ──► decideByStale(m) per manifest:
            age < STALE_STABLE_MIN_AGE_DAYS (14d)
                                ──► skip 'too_young'  (grace for fresh stable)
            daysSinceLastInvoke ≤ STALE_STABLE_UNUSED_DAYS (45d)
                                ──► skip 'recently_invoked'
            else                ──► archive trigger='auto-stale'
                                     (stable → archived, FSM.ALLOWED L54)
                                     promoteOrganism({trigger:'auto-stale'})
                                         └─ signed ledger entry + moveOrganism
  The same ArchiveDecision list feeds /evolve-status (per-trigger key metric
  column: overdueDays vs daysSinceLastInvoke) and /evolve-tick (apply when
  dryRun=false + CLAUDE_EVOLVE=on). Phase 9's null-stamp on stable.expiresAt
  is what makes the boundary clean: auto-age can't touch stable because its
  scan set is shadow/proposal only AND stable's TTL field is null — two
  independent locks. auto-stale uses lastInvokedAt as its own field, not
  expiresAt, so the two triggers never step on each other.

Phase 11 archive retrospective (read-only audit side-loop):
        promotions.ndjson (append-only, all signed transitions)
                  └──► archiveRetrospective.summarizeTransitions({windowDays})
                              ├── filter: at ≥ now − windowDays
                              ├── group by TransitionTrigger
                              │     (manual-accept/manual-veto/auto-oracle/
                              │      auto-age/auto-stale — all 5 enum values,
                              │      0-counts kept so UI can show "silent" cats)
                              ├── group by (from→to) edge (string keys)
                              └── split into sub-views:
                                    archivals  (to ∈ archived/vetoed)
                                    promotions (to ∈ shadow/canary/stable/
                                                     proposal; i.e. non-terminal)
        ─► /evolve-status section 1.8 renders:
              total, window edge timestamps,
              byTrigger (omit 0-counts for terseness),
              archivals.total + trig+from breakdown,
              promotions.total + top-3 edges via topN helper.
  Zero writes. Zero FSM involvement. Bad lines skipped with the same
  discipline as promotionFsm.readRecentTransitions. Purpose: let humans
  tune Phase 8 auto-age / Phase 10 auto-stale thresholds empirically
  ("over last 30d, auto-stale=8 but I only have 12 stable — too aggressive,
  bump STALE_STABLE_UNUSED_DAYS from 45→60") without tailing raw ndjson.

Phase 12 ndjson ledger rotation (disk-cap side-loop, all 3 writers):
        promotionFsm.recordTransition
        sessionOrganismLedger.recordSessionOrganismLink
        fitnessOracle.scoreAgainstDimensions
                  └──► appendJsonLine(path, obj)     (unified write fn)
                              ├── rotateIfNeeded(path):
                              │      fileBytes > MAX_LEDGER_BYTES (10MB) ?
                              │        └ yes: unlink foo.ndjson.{maxRotations}
                              │               rename foo.ndjson.{N} → foo.ndjson.{N+1}
                              │               rename foo.ndjson → foo.ndjson.1
                              │               writeFileSync(foo.ndjson, '')
                              │        └ no : (noop — under cap)
                              └── appendFileSync(path, JSON.stringify(obj)+'\n')
  Rotation failure is non-fatal — logForDebugging only, then fall through to
  plain append. Write path NEVER fails because rotation failed (a too-large
  ledger is better than a lost transition). The old cold files (.1/.2/.3) are
  pure archives; no read path queries them, so the existing readers
  (readRecentTransitions / recentFitnessScores / readSessionOrganismLinks /
  archiveRetrospective) remain bit-identical — rotation is a side-loop, not
  a protocol change. `/evolve-tick` can call `rotateIfNeeded` directly for
  cold maintenance if a writer was dormant long enough that no append ever
  crossed the threshold.

Phase 14 kind-specific loader install/uninstall (stable promotion side-effect):
  promoteOrganism (toStatus='stable', step 6):
        registerStableGenomeAsSkillDir()   ── Phase 4, skill kind only
        installKindIntoClaudeDirs(manifest, orgDir) ── Phase 14, all kinds:
            kind='skill'  → no-op (skill loader already has orgDir)
            kind='prompt' → no-op (reference-only)
            kind='command'→ symlinkSafe(orgDir/<name>.md,
                                        <claudeBase>/commands/<name>.md)
            kind='agent'  → symlinkSafe(orgDir/<name>.md,
                                        <claudeBase>/agents/<name>.md)
            kind='hook'   → copyFileSync(hook.sh + hook.config.json)
                            → <autoEvolve>/installed-hooks/<id>/ (chmod 0755)
                            → appendJsonLine(pending-hooks.ndjson,
                                 {action:'install', organismId, commandPath,
                                  suggestedEvent, suggestedMatcher, hint})
                            (reviewer pastes into settings.json manually)
  promoteOrganism (fromStatus='stable', toStatus ∈ {archived, vetoed}):
        uninstallKindFromClaudeDirs(manifest):
            command/agent → unlink only if dst is a symlink
                            (user-owned files are refused-to-delete + warned)
            hook          → rm -rf installed-hooks/<id>/
                            + appendJsonLine(pending-hooks.ndjson,
                                {action:'uninstall', commandPath, hint})
  Both paths: failures logged via logForDebugging, never roll back the signed
  promotion ledger. symlinkSafe outcomes are typed
  (created/existed-correct/skip-user-file/skip-other-symlink/error), so
  repeated promote-to-stable is idempotent (existed-correct short-circuits).
```

**Every transition writes one signed line to `~/.claude/autoEvolve/oracle/promotions.ndjson`.**
Signature = `sha256(organismId|from|to|trigger|rationale|at [|oracleScoreSig])`.

### Allowed transitions (FSM)

| from ↓ \ to → | proposal | shadow | canary | stable | vetoed | archived |
|---|---|---|---|---|---|---|
| proposal | — | ✓ | — | — | — | ✓ |
| shadow   | — | — | ✓ | — | ✓ | ✓ |
| canary   | — | — | — | ✓ | ✓ | ✓ |
| stable   | — | — | — | — | — | ✓ |
| vetoed   | (terminal) | — | — | — | — | — |
| archived | (terminal) | — | — | — | — | — |

Any other combo → `promoteOrganism` returns `{ ok: false, reason: 'transition not allowed' }`.

### Manual review commands

```
/evolve-accept <id>                 → auto next tier (shadow→canary, canary→stable)
/evolve-accept <id> --to=stable     → explicit target, FSM-validated
/evolve-accept <id> looked good, win met  → trailing tokens = rationale (signed)

/evolve-veto <id>                   → move to vetoed/, mark source memories
/evolve-veto <id> reason words...   → trailing tokens = veto rationale
```

During normal runtime the kernel stays **observation-only**:
`scoreSubject()` appends 5-dim fitness records to `oracle/fitness.ndjson` for
later `/evolve-status` and meta-evolver consumption.

## When to extend

### Add a new mining heuristic
Edit `patternMiner.ts`:
- Add regex to `HOOK_HINTS` / `SKILL_HINTS` (kind selection prioritizes hook).
- If the new heuristic needs structured markdown parsing, reuse
  `extractStructuredSection()` — keys map to the frontmatter convention
  **Why:** / **How to apply:** from CLAUDE.md.
- **Dedup discipline**: every candidate must pass through
  `listCoveredFeedbackMemories()` — a feedback memory already listed in
  some manifest's `origin.sourceFeedbackMemories` is considered covered.

### Add a new organism `kind`
Edit `types.ts#GenomeKind`, then teach both the renderer and the installer:
- **bodyRenderers.ts** (Phase 13): add a `case '<newkind>'` to
  `renderBodyForKind` returning `{primary, extras?}`. Pick a primary filename
  that is unique across kinds (or reuse `<name>.md` like command/agent do).
  Append any new primary filename(s) to `ALL_PRIMARY_FILENAMES` or re-compile
  will leak residue when a pattern's kind changes.
- **kindInstaller.ts** (Phase 14): add a `case '<newkind>'` to both
  `installKindIntoClaudeDirs` and `uninstallKindFromClaudeDirs`. Follow the
  existing patterns — `symlinkSafe` for loader-style kinds that need to
  appear inside `~/.claude/`, `copy + pending-hooks-style queue` for kinds
  that require out-of-band reviewer action, or a no-op with a descriptive
  `reason` for reference-only kinds. Never mutate user-owned config files
  (settings.json etc.) from the installer — always route through the
  `pending-hooks.ndjson` pattern or a similar append-only queue.

### Add a new fitness dimension
Edit `fitnessOracle.ts`:
1. Add field to `FitnessScore['dimensions']` in `types.ts`.
2. Add `calc<Dim>(input: FitnessInput)` — must clamp to `[-1, 1]`.
3. Add weight field to `OracleWeights` + `DEFAULT_ORACLE_WEIGHTS`.
4. Bump `version` string (`v1-YYYY-MM-DD` → `v2-...`). **Do not silently replace
   weights** — `loadOracleWeights()` falls through to the default only for
   missing keys, so old `weights.json` keeps working.
5. Include dim in `aggregate()` raw sum AND weightSum normalization.
6. Extend `safety` veto logic **only** if the new dim is a veto (otherwise it
   participates in weighted average).

### Wire a new learner into the registry
```ts
import { registerLearner } from '../autoEvolve/index.js'

registerLearner<MyParams, MyOutcome>({
  domain: 'my-domain',
  loadParams: () => /* read from disk or in-memory */,
  saveParams: p => /* persist */,
  recordOutcome: rec => /* ε-greedy / bandit / gradient update */,
  describe: () => `MyLearner(ε=${eps})`,
})
```
`ensureBuiltinLearners()` lazy-registers the built-ins; call from any entry
that wants the registry populated (`/evolve-status` already does this).

## Invariants

- **Read-only default**: `CLAUDE_EVOLVE=off` means mining / compilation /
  scoring can still run as libraries, but no auto-promotion. `CLAUDE_EVOLVE_SHADOW=on`
  is the safety default — new organisms land in `shadow/`, never in stable loaders.
- **No synthetic inputs**: Pattern Miner must read real memdir files. Aligns
  with `feedback_dream_pipeline_validation` — zero headless/mock inputs.
- **Oracle signatures**: every `FitnessScore` carries `signature = sha256(score,
  dims, scoredAt)`. Unsigned ledger entries are invalid.
- **Idempotent compilation**: `makeOrganismId()` = `sha256(name + ':v1')` — same
  candidate recompiles to the same id (overwrite semantics, not duplication).
- **Path discipline**: all writes go to `~/.claude/autoEvolve/`. Never write to
  the repository (that's Phase 2's worktree spawn territory).
- **TTL**: shadow organisms expire 30 days after `createdAt` (aligned with
  evidenceLedger default). Expired shadows auto-archive (Phase 2).
- **Stable-as-skill** (Phase 4): every organism in `genome/stable/` is a
  discoverable prompt-type skill. `addSkillDirectories` is idempotent +
  concurrency-safe, so `promoteOrganism(to='stable')` and the `/evolve-status`
  boot hook can both call `registerStableGenomeAsSkillDir()` without dup loads.
- **Attribution atomicity** (Phase 4): `recordOrganismInvocation` uses
  tmp-file + rename to update `manifest.json` — `invocationCount` monotonically
  increases; `lastInvokedAt` always reflects the most recent successful write.
- **Invocation hook auto-fires** (Phase 5): every call to a stable organism's
  skill goes through `wrapStableSkillsWithInvocationHook`'s bump-first wrapper.
  Bump runs *before* `await originalGetPromptForCommand`, so failure of the
  wrapped call still yields a valid attribution record. The WeakSet guard
  prevents double-wrap → no double-counting even if registration runs multiple
  times in one session.
- **Auto-promotion guarded by flag + oracle gate** (Phase 6):
  `applyAutoPromotions({ dryRun: false })` only writes to the ledger when the
  caller explicitly opts in. `/evolve-tick --apply` additionally requires
  `CLAUDE_EVOLVE=on`; `/evolve-status` preview is always dry-run regardless of
  flag. The Oracle macro gate (recent avg < -0.5 over ≥3 samples) holds ALL
  candidates, preventing mass promotion during adverse conditions. Every
  auto-promotion writes a signed transition with `trigger='auto-oracle'` and
  rationale = the engine's reason string.
- **Per-organism aggregation is a read-only side loop** (Phase 7): the Aggregator
  only reads `fitness.ndjson` + `session-organisms.ndjson` — it never writes
  them. `refreshOrganismFitness` is the only writer, and it only touches
  `manifest.fitness.{shadowTrials,wins,losses,neutrals,lastTrialAt,lastScoreSignature}`
  via tmp+rename. `invocationCount` / `lastInvokedAt` stay owned by Phase 5's
  bump path — never co-written to avoid torn updates.
- **Bucket thresholds = Oracle policy** (Phase 7): `ORGANISM_WIN_THRESHOLD=0.3`
  and `ORGANISM_LOSS_THRESHOLD=-0.3` in `oracleAggregator.ts` must be bumped in
  lockstep with DEFAULT_ORACLE_WEIGHTS changes. If `fitnessOracle`'s weight
  vector changes such that a "single good signal" no longer normalizes to
  ≥0.3, the win/loss semantics drift silently.
- **Adverse veto > favorable relax** (Phase 7 decide): if both conditions can
  be true in theory (they can't given |score|≥0.3 dichotomy, but defensively),
  adverse veto runs first — a per-organism short-circuit hold cannot be
  overridden by age-relaxation. Order in `decide()` is load-bearing.
- **Auto-age archival reuses the transition spine** (Phase 8): `applyAutoArchive`
  does NOT open a new writer — it delegates to `promoteOrganism` with
  `toStatus='archived'`, so signed-ledger, FSM validation (shadow/proposal →
  archived only), directory move, and rationale formatting all come from one
  place. There's no "archive-specific" code path to keep in sync with
  promotion — adding a future trigger (e.g. `auto-ttl-hard`) is just another
  string value.
- **Expiry is not filtered by the Oracle macro gate** (Phase 8): the Oracle
  trend gate only holds *upward* transitions during adverse conditions.
  Archival of an already-expired organism is an independent fact — the
  user/system decided 30 days ago how long this candidate gets, and Oracle
  trend can't retroactively extend it.
- **Refresh is a stale-read firewall, not a correctness gate** (Phase 9):
  `refreshAllOrganismFitness()` is called at `/evolve-status` entry and at
  the top of `applyAutoPromotions`. Both call sites wrap it in try/catch —
  a refresh failure must NEVER block the panel render or the promotion
  decision. `decide()` also re-queries the aggregator directly, so even if
  refresh's manifest writeback fails, the in-memory decision still sees
  live data — refresh only serves the "what does `manifest.fitness` show
  next time I read the file" question.
- **TTL re-stamp owns the promotion-tier observation window** (Phase 9):
  `restampExpiresAtOnPromote(toStatus, id)` runs inside `promoteOrganism`
  between ledger-write (step 4) and manifest-readback (step 5). It sets
  canary → `now + CANARY_TTL_DAYS` (60d default) and stable → `null`
  (immune to auto-age). Existing shadow `expiresAt = createdAt + 30d`
  is untouched — only tier-upward promotions re-stamp. Failure is logged
  + swallowed (not rolled back): a missed re-stamp at worst means the
  candidate inherits residual shadow TTL, which auto-age will flag on the
  next `/evolve-tick`; still no double-archive risk because FSM rejects
  the already-advanced state transition.
- **stable gets `expiresAt=null`** (Phase 9): auto-age is shadow/proposal
  only by scan design, and the null stamp makes this property explicit
  in the manifest itself. Any future "stale stable reaper" must use a
  different field (e.g. `lastInvokedAt`) to express a distinct policy —
  `expiresAt` is now reserved for the "created-under-observation" window.
- **auto-stale uses `lastInvokedAt`, not `expiresAt`** (Phase 10): the
  Phase 9 null-stamp promise holds — stable organisms keep `expiresAt=null`
  forever, and `autoArchiveEngine`'s stale path consults only
  `manifest.lastInvokedAt` (written atomically by `recordOrganismInvocation`
  on every getPromptForCommand bump). `daysSinceLastInvoke` falls back to
  age-from-createdAt when lastInvokedAt is null, so "never-invoked stable"
  still decays naturally past the 14d grace + 45d idle thresholds.
- **Two-lock isolation between auto-age and auto-stale** (Phase 10):
  auto-age cannot touch stable (scan set is shadow/proposal only AND
  stable.expiresAt is null), and auto-stale cannot touch shadow/proposal
  (scan set is stable only). Neither trigger can double-archive the other's
  subjects, even if someone later flips a flag. The TransitionTrigger union
  now carries both values as first-class citizens (`auto-age` | `auto-stale`)
  so the signed ledger preserves the distinction forever.
- **Grace period on fresh stable is mandatory** (Phase 10):
  `STALE_STABLE_MIN_AGE_DAYS=14` is not a convenience — it's what prevents
  a "promoted-to-stable → immediately-auto-stale-harvested" flapping loop
  for skills that happen to have a quiet period right after promotion.
  The grace is shorter than any reasonable observation window
  (canary→stable gate requires ≥3d + ≥10 invocations already) so it
  doesn't mask real "dead on arrival" cases beyond two weeks.
- **Retrospective is strictly read-only** (Phase 11): `archiveRetrospective`
  never writes, never triggers FSM transitions, and never refreshes
  manifests. It reads `promotions.ndjson` once per call, reuses the same
  bad-line-skip discipline as `promotionFsm.readRecentTransitions`, and
  returns a plain record. A broken ledger file yields empty counts,
  not an exception — so the /evolve-status panel stays renderable even if
  the ledger is corrupted.
- **Trigger enum is a schema contract** (Phase 11): `summarizeTransitions`
  initializes `byTrigger` with all 5 enum values (zero-valued) before
  counting, so the UI can distinguish "trigger happened 0 times this
  window" from "trigger doesn't exist in the codebase". Any new
  `TransitionTrigger` value (e.g. future `auto-stale` → `auto-stale-v2`)
  MUST also be added to `ALL_TRIGGERS` in archiveRetrospective.ts,
  otherwise it will be counted in `total` + `byFromTo` but silently
  omitted from the trigger breakdown. The file carries a comment
  reminding future authors.
- **Rotation is a pure-append side-effect** (Phase 12): `appendJsonLine`
  preserves every existing reader's contract bit-for-bit — the main
  `foo.ndjson` continues to hold the newest tail in the same
  `JSON.stringify(obj)+'\n'` format, and rotated `.1/.2/.3` files are
  cold archives that no read path (readRecentTransitions /
  recentFitnessScores / readSessionOrganismLinks / archiveRetrospective)
  queries. A future "merged reader" phase could fold them in, but today
  rotation is purely a disk-cap primitive.
- **Rotation never blocks the write path** (Phase 12): `appendJsonLine`
  calls `rotateIfNeeded` best-effort — rotation failure (missing
  permission, rename race, disk full) is logged via `logForDebugging`
  and then falls through to a plain `appendFileSync`. The invariant:
  "a transition/fitness-score/session-link that would have been written
  BEFORE Phase 12 is still written AFTER Phase 12, even when rotation
  is broken". The cost of a too-large ledger is recoverable (next
  successful rotate cleans up); the cost of a lost signed transition
  is not.
- **Skill body is byte-identical across Phase 1 → Phase 13** (Phase 13):
  `bodyRenderers.renderSkillBody` produces the exact same bytes as
  the Phase 1 `skillCompiler.renderSkillBody` given the same candidate
  + `nowIso()` output. This is a load-bearing contract because
  `registerStableGenomeAsSkillDir` hands the organism directory
  directly to Claude Code's skill loader, and the loader's attribution
  is keyed by the `name + description` frontmatter pair. Any change
  to that frontmatter pair (e.g. renaming `status:` to `phase:`)
  would look like a fresh skill to the loader and orphan the
  `invocationCount` / `lastInvokedAt` history of every existing
  stable organism. bodyRenderers preserves the Phase 1 template
  verbatim for kind='skill'; new frontmatter fields must go on the
  non-skill kinds only.
- **Non-skill kinds are shadow-only until /evolve-accept** (Phase 13):
  Only `kind='skill'` is auto-registered into the Claude Code skill
  loader by `registerStableGenomeAsSkillDir` (Phase 4). `command`,
  `agent`, `hook`, and `prompt` kinds produce correctly-formatted
  artifacts in the organism directory but stay there — /evolve-accept
  is the handoff point where a human copies the file into
  `~/.claude/commands/`, `~/.claude/agents/`, or wires the hook into
  `settings.json` (per hook.config.json's reviewerInstructions).
  This keeps the arena boundary intact: autoEvolve never mutates
  loader-owned configuration by itself.
- **Stale-cleanup is name-whitelisted, not name-blacklisted**
  (Phase 13): `cleanupStaleBodyFiles` only considers filenames in
  `ALL_PRIMARY_FILENAMES = ['SKILL.md', 'PROMPT.md', 'hook.sh',
  'hook.config.json']`. Anything else in the organism directory
  (manifest.json, reviewer-added notes, future kind-specific files)
  is left alone. New kinds that introduce new primary filenames
  MUST add them to ALL_PRIMARY_FILENAMES, otherwise a re-compile
  that changes kind will silently leak the old body. The file
  carries a comment reminding future authors of this contract.
- **kindInstaller never overwrites non-symlink files** (Phase 14):
  `symlinkSafe(src, dst)` reads `lstatSync(dst)` first and returns one
  of `created / existed-correct / skip-user-file / skip-other-symlink /
  error`. Only `created` and `existed-correct` (our own symlink already
  pointing at srcAbs — idempotent) are success states; anything else
  is reported as a warning and the install is skipped with
  `installed=false`. The invariant: a user who hand-placed a file at
  `<claudeBase>/commands/<name>.md` or `<claudeBase>/agents/<name>.md`
  with the same name as an organism will NEVER have their file
  clobbered by promotion. Uninstall follows the same discipline —
  `unlinkSync` runs only when `lstatSync(dst).isSymbolicLink()` is
  true, user-owned files are left in place.
- **autoEvolve never mutates settings.json** (Phase 14): hook install
  cannot directly register the hook into Claude Code's runtime because
  the hook registry lives in `~/.claude/settings.json`, which is
  user-root permission space. Instead, kindInstaller copies `hook.sh`
  (+ optional `hook.config.json`) to
  `~/.claude/autoEvolve/installed-hooks/<id>/` (autoEvolve-owned) and
  appends a structured event to `pending-hooks.ndjson` with the
  canonical `commandPath` plus a `hint` describing where in
  settings.json the reviewer should paste it. The reviewer retains
  final authority; `/evolve-status` can surface the queue so pending
  installs don't silently pile up.
- **Stable-exit always queues the inverse event** (Phase 14):
  `uninstallKindFromClaudeDirs` appends the `{action:'uninstall'}` line
  to `pending-hooks.ndjson` even when the install dir was already
  absent (`cleaned=false`). Rationale: the audit chain
  (install → uninstall) must stay symmetric — a reviewer might have
  manually wired the hook into settings.json after seeing the install
  event, and still needs the uninstall reminder when the organism is
  archived/vetoed, regardless of whether the staging dir still exists.
  Append-only pending-hooks.ndjson rides on Phase 12's ndjsonLedger
  rotation, same as the other three ledgers.
- **Install/uninstall failure never rolls back promotion** (Phase 14):
  both entry points in arenaController.promoteOrganism are wrapped in
  try/catch that logs via `logForDebugging` and swallows the error.
  Rationale: the signed promotion ledger entry has already been
  appended by step 4 (recordTransition); rolling it back would require
  writing a "reverse transition" not in the FSM. A failed install is
  recoverable (re-run `/evolve-accept`, fix the conflicting file,
  re-promote). A phantom ledger entry is not.
- **Pending-hooks readers never mutate the ledger** (Phase 15):
  `readPendingHookEvents` / `listInstalledHookOrganismIds` /
  `formatPasteReadyHookJson` are strictly read-only. Malformed
  ndjson lines are counted (`summary.malformedLines`) and skipped,
  NEVER truncated or rewritten. Rationale: the ndjson is the
  authoritative audit chain; fixing it is the reviewer's job,
  not the panel's. Panel snippets are pure derivations — pasting
  into settings.json is an explicit human act, never automatic.
  Cross-checking ledger-active vs installed-hooks/ on disk is
  likewise read-only — drift is surfaced as a warning, not
  silently repaired (silent repair could mask a real bug).
- **Preview never writes to disk** (Phase 16):
  `previewInstallKindIntoClaudeDirs` /
  `previewUninstallKindFromClaudeDirs` are pure — they must NOT
  call `symlinkSync`, `copyFileSync`, `appendJsonLine`, `ensureDir`,
  `rmSync`, or any other mutating fs op. They may only `lstatSync`,
  `existsSync`, `readlinkSync`, and `resolve`. Rationale: a
  `/evolve-accept --dry-run` on a fresh machine must leave zero
  residue — no stray `installed-hooks/` directory, no preemptive
  pending-hooks line, no symlink at the expected `commands/` path.
  The reviewer's mental model is "dry-run is a pure simulation";
  breaking this invariant erodes trust in the whole preview path.
  Preview shares lstat decision logic with the real path via the
  private `peekSymlink` helper, so outcome classes
  (created/existed-correct/skip-user-file/skip-other-symlink/error)
  stay identical between simulation and execution.

## Observability

- `/evolve-status` — 12 sections: Feature flags / Arena counts + recent shadows
  + stable organism attribution list (Phase 7: each stable row shows per-organism
  `fitness: trials=N W=w L=l N=n avg=±x (live|manifest)` — `live` = computed from
  aggregator now, `manifest` = fallback to persisted `manifest.fitness` snapshot
  when aggregator yields trials=0) / Recent transitions / Auto-Promotion Preview
  (Phase 7: reasons may read `per_org_adverse` or `[age threshold relaxed]`) /
  Auto-Archive Preview (Phase 8: lists expired shadow/proposal with
  `overdue=Nd`) / Oracle weights + recent fitness / Pattern Miner dry-run /
  Learners / **Pending Hook Installs (Phase 15)** — active install queue from
  `pending-hooks.ndjson` with per-entry paste-ready `settings.json` snippet,
  `installed-hooks/` dir roster, ledger↔dir drift warning / **Installed Settings
  Snapshot (Phase 23)** — replays `installed-settings.ndjson` via
  `listCurrentlyMergedTargets()`, cross-checks each entry against the live
  `~/.claude/settings.json` via `detectSettingsDrift()`; shows
  `total merged / intact / hand-modified`, marks intact rows with a space and
  hand-modified rows with `!`, and suggests `/evolve-install-hook <id> --remove`
  when drift is present / **Recent Goodhart Vetoes (Phase 22)** — tails
  `goodhart.ndjson` (default 10, reverse-chronological), prints organism +
  `kind=…` + `status=…` + `reasons=[…]` + a metrics line (`bodyBytes / trials /
  losses / avg / flatFrac / firstAvg / secondAvg`), and a `rule frequency`
  aggregate at the bottom so reviewers see which of R1-R4 fires most / Paths
  (now also printing `installed-settings` and `goodhart-ledger` absolute
  locations). Each section independent try/catch (one failure doesn't poison
  others — same pattern as `/kernel-status`). Also triggers
  `ensureStableGenomeRegistered()` on entry as a boot hook for skill-loader
  coverage AND invocation-hook re-wrap.
- `evidenceLedger` domain `'evolve'` (added 2026-04-22) — for Phase 2 when
  arena transitions write evidence.
- `memoryLifecycle.TYPE_DECAY_RATE.genome = 0.005` — slowest decay tier:
  a successful organism "stays alive" the longest under hit-based retention.
- Phase 7 ledger: `~/.claude/autoEvolve/oracle/session-organisms.ndjson`
  (one `{sessionId, organismId, at}` line per stable invocation). Phase 12:
  all 3 ledgers (promotions / fitness / session-organisms) now go through
  `ndjsonLedger.appendJsonLine`, which auto-rotates any main file past
  MAX_LEDGER_BYTES (10MB) into `.1/.2/.3` cold archives. Read paths are
  unchanged — hot readers query only the main file.
- Phase 14 queue: `~/.claude/autoEvolve/pending-hooks.ndjson` — one
  `{action: 'install'|'uninstall', organismId, name, commandPath, ...}`
  line per hook kind promotion event. Reviewer reads this queue to decide
  which entries to paste into `~/.claude/settings.json` hooks block.
  Rides the same Phase 12 rotation as the oracle ledgers.
  `~/.claude/autoEvolve/installed-hooks/<id>/` holds the staged
  `hook.sh` (chmod 0755) + optional `hook.config.json` — removed on
  stable exit.

## Phase 41 → Phase 42 roadmap

- **DONE (Phase 7)**: per-organism Oracle aggregation. Stable invocations log
  `(sessionId, organismId)` to `oracle/session-organisms.ndjson`; the
  `oracleAggregator` reverse-attributes session-level FitnessScores to
  organisms; `refreshAllOrganismFitness` persists the aggregate into
  `manifest.fitness`; the auto-promotion `decide()` uses it for adverse veto +
  favorable age relax.
- **DONE (Phase 42, shadow sandbox + minimal read-only runner)**:
  `services/autoEvolve/arena/sandboxFilter.ts` closes the policy gap for
  shadow mode by default-allowing only read-only tools (`Read`, `Glob`,
  `Grep`, `WebFetch`, `NotebookRead`, `ListMcpResourcesTool`,
  `ReadMcpResourceTool`) and deny-listing side-effectful tools (`Bash`,
  `Edit`, `Write`, `NotebookEdit`, `Agent`, `DelegateToExternalAgent`,
  `AskUserQuestion`, etc.); unknown tools also default to deny. The
  reviewer command `/evolve-shadow-sandbox-check` prints per-tool
  allow/deny + rationale so policy changes stay auditable. The same module
  now also exposes `isShadowSandboxToolAllowed(...)` and
  `assertShadowSandboxToolAllowed(...)`, so the exact allow/deny verdict can
  be reused at execution time instead of being reimplemented in a second
  runtime-only policy path. On top of the policy layer,
  `services/autoEvolve/arena/shadowRunner.ts` adds a thin
  execution API: `planShadowRun(...)` returns the sandbox-filtered plan,
  while `startShadowRun(..., {executeReadOnly:true})` executes only the
  allow-listed read-only subset against the organism worktree. Current
  read-only support is intentionally narrow but real: `Read` previews
  multiple `targetFiles`; `Glob` applies `globPattern`; `Grep` supports
  literal/regex matching via `grepIsRegex` plus `grepHeadLimit` and now
  shows matched snippets instead of whole-file previews; `WebFetch`
  enforces a public-url policy (rejects localhost / 127.0.0.1 /
  0.0.0.0 / `*.local` / `*.internal`), blocks unsupported content-types /
  overlarge `content-length`, and returns a trimmed preview only.
  Output rendering is now intentionally centralized inside
  `shadowRunner.ts`: `renderShadowRunInputSummary`,
  `renderShadowExecutionLine`, `renderShadowDeniedToolLine`,
  `renderShadowToolPolicySection`, `renderShadowPlanHeader`,
  `renderShadowExecutionSection`, `renderSingleShadowRunReport`,
  `renderArenaShadowPlanBlock`, and `renderArenaShadowExecutionBlock`
  keep `/evolve-shadow-run <id>` and `/evolve-arena --spawn-auto ...`
  text-stable while the executor evolves. Executor behavior is also being
  normalized behind shared constants instead of scattered literals:
  default targets/patterns (`DEFAULT_READ_TARGET_FILES`,
  `DEFAULT_GLOB_PATTERN`, `DEFAULT_GREP_NEEDLE`,
  `DEFAULT_GREP_HEAD_LIMIT`), sampling caps (`MAX_FILE_SAMPLE`,
  `MAX_GLOB_MATCHES`), preview windows
  (`READ_PREVIEW_RENDER_CHARS`, `GLOB_PREVIEW_RENDER_CHARS`,
  `GREP_MATCH_CONTEXT_BEFORE`, `GREP_MATCH_CONTEXT_AFTER`,
  `GREP_PREVIEW_RENDER_CHARS`, `WEB_PREVIEW_SOURCE_BYTES`,
  `WEB_PREVIEW_RENDER_CHARS`), and web size guard
  (`WEB_MAX_CONTENT_LENGTH`). Dynamic inputs
  (`--query-text`, `--target-files`, `--grep-needle`, `--web-url`) now
  flow through the same shared renderers instead of command-local
  `JSON.stringify(...)` formatting. The read-only executor now also performs
  a second sandbox check immediately before each `Read` / `Glob` / `Grep` /
  `WebFetch` call via `runShadowReadOnlyTool(...)`, returning
  `blocked by runtime sandbox` if a tool somehow drifts past plan-time
  filtering. This pushes Phase 42 one step closer to real runtime
  enforcement while still staying local to shadow mode. A new
  `services/autoEvolve/arena/shadowToolRuntime.ts` module now reuses the
  real tool registry plus each tool's own `validateInput(...)` and
  `checkPermissions(...)` path, so shadow execution no longer relies only on
  a hand-rolled allowlist assertion before read-only execution. The runtime
  context stub used by this path is also centralized in
  `services/autoEvolve/arena/shadowRuntimeContext.ts`, which gives Phase 42+
  a shared adapter seam for shadow-only tool validation without duplicating
  context-shape boilerplate inside `shadowRunner.ts`. Phase 42 also now has
  an initial real-call bridge in `shadowToolRuntime.ts`: the shadow `Read` /
  `Glob` / `Grep` / `WebFetch` paths can invoke the actual runtime tool
  `call(...)` after sandbox/validate/permission checks, while `WebFetch`
  still preserves the extra shadow-only public-URL guard before runtime
  invocation. The next step is now partially landed as a new
  `services/autoEvolve/arena/shadowWorkerAdapter.ts` seam: `shadowRunner.ts`
  delegates read-only execution to a worker-compatible local adapter instead
  of keeping all runtime-call branches inline, and `allowedTools` is narrowed
  through both the real async-worker capability ceiling
  (`ASYNC_AGENT_ALLOWED_TOOLS`) and the shadow sandbox policy. This keeps the
  current Phase 42 surface read-only/local, but moves the executor one layer
  closer to a future real worker/runtime handoff without changing the command
  or renderer contract.
- **DONE (Phase 8)**: TTL-driven auto-archival. `autoArchiveEngine` scans
  shadow + proposal for `expiresAt < now` and delegates to `promoteOrganism`
  with `trigger='auto-age'` — same signed-ledger + FSM + moveOrganism spine
  as every other transition. Preview in `/evolve-status`, apply via
  `/evolve-tick --apply` (requires CLAUDE_EVOLVE=on). Oracle macro gate does
  not apply to archival (expiry is an independent fact).
- **DONE (Phase 9, Refresh scheduling)**: `refreshAllOrganismFitness` is now
  auto-invoked at `/evolve-status` entry (after `ensureStableGenomeRegistered`)
  and at the top of `applyAutoPromotions`. Both call sites wrap it in
  try/catch so the panel / decision path is never blocked by a refresh
  hiccup. `decide()` also re-queries the aggregator directly, so refresh is
  a stale-read firewall for `manifest.fitness`, not a correctness gate.
- **DONE (Phase 9, Canary/stable TTL policy)**: `promoteOrganism` now runs
  `restampExpiresAtOnPromote(toStatus, id)` between ledger-write (step 4) and
  manifest-readback (step 5). `canary` → `now + CANARY_TTL_DAYS` (60d),
  `stable` → `null` (immune to auto-age). Failure is logged + swallowed
  (not rolled back) — TTL is a soft observation window, not a hard
  correctness property.
- **DONE (Phase 10, stale-stable reaper)**: `autoArchiveEngine` now has a
  second scan path over `stable` using `manifest.lastInvokedAt`. New
  constants `STALE_STABLE_UNUSED_DAYS=45` + `STALE_STABLE_MIN_AGE_DAYS=14`
  gate `trigger='auto-stale'` promotions (routed through the identical
  `promoteOrganism` signed-ledger path). Preview merges into the same
  `/evolve-status` Auto-Archive section with a per-trigger key-metric
  column (overdue vs idle), and `/evolve-tick --apply` archives with
  `trigger=d.trigger` — no hard-coded trigger anymore. Real-disk dry-run
  against 2 live stable organisms (age=0.1d) returns `skip 'too_young'`,
  confirming the grace period works end-to-end.
- **DONE (Phase 11, cross-trigger archive audit)**:
  `archiveRetrospective.summarizeTransitions({windowDays=30})` reads
  `promotions.ndjson` once per call, filters to the rolling window, and
  groups by `TransitionTrigger` (zero-initialized over all 5 enum values)
  and `(from→to)` edge. Sub-views split archivals (to ∈ archived/vetoed)
  from promotions (to ∈ non-terminal). Surfaced in `/evolve-status`
  section 1.8 with zero-count triggers omitted for terseness + top-3
  promotion edges via `topN`. Pure read, bad-line-skip discipline
  identical to `readRecentTransitions`. Real-ledger baseline (6 entries):
  byTrigger `manual-accept=4, manual-veto=1, auto-oracle=1`,
  archivals=1 (shadow→vetoed), promotions=5, validated end-to-end.
- **DONE (Phase 12, ndjson ledger rotation)**:
  `services/autoEvolve/oracle/ndjsonLedger.ts` centralises the append
  pattern previously scattered across 3 writers. `appendJsonLine(path, obj)`
  calls `rotateIfNeeded(path)` first (> MAX_LEDGER_BYTES=10MB →
  rename `.N→.N+1` up to MAX_ROTATED_FILES=3, oldest dropped, main → `.1`,
  new empty main) then `appendFileSync`. Rotation failure degrades to
  plain append silently (logForDebugging only). Migrated writers:
  `promotionFsm.recordTransition`, `sessionOrganismLedger.recordSessionOrganismLink`,
  `fitnessOracle.scoreAgainstDimensions`. All existing readers
  (`readRecentTransitions`, `recentFitnessScores`, `readSessionOrganismLinks`,
  `archiveRetrospective.summarizeTransitions`) are bit-identical —
  rotation is a pure side-effect that never changes the main file's
  line format. `/evolve-tick` can invoke `rotateIfNeeded` directly for
  cold maintenance.
- **DONE (Phase 13, kind-specific body renderers)**:
  `services/autoEvolve/emergence/bodyRenderers.ts` centralises per-kind
  rendering. `renderBodyForKind(kind, candidate)` dispatches:
  skill→`SKILL.md` (byte-identical to Phase 1 — preserves Phase 4 loader
  attribution contract); command→`<name>.md` with
  `{description, allowed-tools: [], argument-hint}` frontmatter and a
  prompt-body skeleton; agent→`<name>.md` with
  `{name, description, tools: [], model: inherit}` frontmatter and a
  system-prompt skeleton; hook→`hook.sh` (shebang + rationale comments
  + TODO skeleton; no fabricated execution logic) plus
  `hook.config.json` (structured reviewer hints: suggestedEvent,
  suggestedMatcher, command path, reviewerInstructions array);
  prompt→`PROMPT.md` reusable snippet. `skillCompiler.compileCandidate`
  now calls the dispatcher, writes primary + extras, and runs a
  `cleanupStaleBodyFiles` whitelist pass (ALL_PRIMARY_FILENAMES) to
  remove residual body files when a re-compile changes kind.
  `CompileResult.extras?: string[]` surfaces hook's secondary file path.
  Validated end-to-end under `CLAUDE_CONFIG_DIR=/tmp/...` across all 5
  kinds: correct file names, correct frontmatter, hook.config.json is
  valid JSON; stale-cleanup round-trip (skill→hook re-compile on same
  id) cleans SKILL.md and emits hook.sh+hook.config.json; real
  `~/.claude/autoEvolve/genome/` untouched.
- **DONE (Phase 14, kind-specific loader install/uninstall)**:
  `services/autoEvolve/arena/kindInstaller.ts` runs inside
  `promoteOrganism` step 6 alongside `registerStableGenomeAsSkillDir`.
  On stable entry: `installKindIntoClaudeDirs(manifest, orgDir)`
  dispatches per kind — `command`/`agent` via `symlinkSafe` into
  `<claudeBase>/commands/` or `<claudeBase>/agents/`, `hook` via
  `copyFileSync` into `<autoEvolve>/installed-hooks/<id>/` plus an
  `{action:'install', ...}` append to `pending-hooks.ndjson`,
  `skill`/`prompt` no-op. On stable exit (archived/vetoed):
  `uninstallKindFromClaudeDirs` unlinks symlinks only when they remain
  symlinks (user files left in place) and rm -rf's the hook install
  dir, then appends `{action:'uninstall', ...}` for symmetric audit.
  `symlinkSafe` returns typed outcomes
  (created/existed-correct/skip-user-file/skip-other-symlink/error)
  so repeated promotions are idempotent. All failures are non-fatal
  (logForDebugging) and never roll back the signed promotion ledger.
  New paths helpers: `getClaudeConfigBaseDir`,
  `getClaudeCommandsInstallDir`, `getClaudeAgentsInstallDir`,
  `getInstalledHooksDir`, `getPendingHooksPath` — all honor
  `CLAUDE_CONFIG_DIR` for /tmp-based test isolation.
- **DONE (Phase 15, reviewer-facing install queue in /evolve-status)**:
  new read-only module `services/autoEvolve/arena/pendingHooksReader.ts`
  parses `pending-hooks.ndjson` line-by-line and reconciles
  install↔uninstall per `organismId` (`active` / `canceled` /
  `orphanUninstalls` / `malformedLines` counters). `/evolve-status`
  gains a 10th section **Pending Hook Installs (Phase 14)** that
  prints the active queue, drift warnings (ledger-only vs dir-only),
  and for each active entry a paste-ready `settings.json` hooks
  snippet (`{[event]: [{matcher, hooks:[{type:"command", command}]}]}`)
  the reviewer copies directly. Paths section now also lists
  `installed-hooks/` and `pending-hooks.ndjson`. Validated end-to-end
  under `CLAUDE_CONFIG_DIR=/tmp/...`: 2 hooks + 1 command promoted to
  stable → panel shows `total=2 active=2 canceled=0`; archive one hook
  → `active=1 canceled=1`; archive the other → `active=0` with
  empty-state message; command organism never enters the Phase 14
  ledger. 27/27 real assertions pass; real `~/.claude` untouched.
- **DONE (Phase 16, /evolve-accept dry-run + side-effect preview)**:
  `/evolve-accept` grew `--dry-run` and a "Phase 14 side effects"
  block that reuses `kindInstaller`'s lstat decision logic via the
  new `previewInstallKindIntoClaudeDirs` /
  `previewUninstallKindFromClaudeDirs` pure helpers
  (shared `peekSymlink` — no `symlinkSync` / `copyFileSync` /
  `appendJsonLine` / `ensureDir` on the preview path, verified).
  FSM pre-check (`isTransitionAllowed`) now runs in BOTH dry-run
  and real mode before any disk work, so illegal transitions fail
  identically. On a real stable promotion of `kind=hook` the
  command output also appends the paste-ready `settings.json`
  snippet sourced from `pendingHooksReader.formatPasteReadyHookJson`
  — reviewer no longer has to run `/evolve-status` to retrieve it.
  Validated under `CLAUDE_CONFIG_DIR=/tmp/...`: 26/26 real
  assertions pass across hook/command/skill kinds covering
  dry-run purity (status stays, no fs residue), snippet JSON.parse
  validity, absolute `installed-hooks` command path, invalid
  `stable→canary` dry-run rejected by FSM; real `~/.claude`
  untouched.
- **DONE (Phase 17, /evolve-veto dry-run + veto preview)**:
  `/evolve-veto` grew `--dry-run` mirroring the Phase 16
  `/evolve-accept` pattern. Two read-only previewers are wired in:
  `renderUninstallPreview(manifest, fromStatus)` reuses the
  Phase 16 `previewUninstallKindFromClaudeDirs` helper and is
  kept defensively (FSM rules forbid stable→vetoed so the preview
  body is currently unreachable via /evolve-veto — but the helper
  stays wired so we don't regress if the FSM table relaxes later);
  `renderVetoedIdsPreview(manifest)` diffs
  `manifest.origin.sourceFeedbackMemories` against
  `readVetoedFeedbackMemories()` and emits the `+ memory.md`
  lines that Pattern Miner would newly skip. FSM pre-check
  (`isTransitionAllowed(from, 'vetoed')`) runs BEFORE any disk
  work in both dry-run and real modes — so stable→vetoed and
  vetoed→vetoed surface the same `rejected by FSM` error
  identically. Dry-run is strictly read-only: no
  `vetoOrganismWithReason`, no `markFeedbackVetoed`, no directory
  move — `vetoed-ids.json` is never created on a pure dry-run
  and the organism never leaves its current status directory.
  Validated under `CLAUDE_CONFIG_DIR=/tmp/...`: 34/34 real
  assertions pass across shadow/canary dry-run + real veto +
  stable→vetoed FSM rejection (both dry-run and real paths) +
  vetoed→vetoed double-veto rejection; real `~/.claude`
  untouched.
- **DONE (Phase 18, /evolve-archive manual recycle command)**:
  New `/evolve-archive <id> [--dry-run] [reason...]` command closes
  the manual-recycle gap that blocked human retirement of stable
  organisms — the FSM permits `proposal/shadow/canary/stable →
  archived` but veto cannot touch `stable` (FSM blocks
  stable→vetoed). Added a new TransitionTrigger `manual-archive`
  (synced into `archiveRetrospective.ALL_TRIGGERS`), and
  `archiveOrganismWithReason` in arenaController mirrors
  `vetoOrganismWithReason` but targets `archived` and
  intentionally does NOT call `markFeedbackVetoed` — archive is
  instance-level retirement, not source-level blacklist, so
  Pattern Miner retains the right to re-mine the same memories
  when conditions change. The critical consequence: `stable →
  archived` is the first real-world caller that actually reaches
  Phase 17's `renderUninstallPreview` body (previously defensive
  only), so Phase 14's uninstallKindFromClaudeDirs now fires on
  manual retirement — unlinking symlinks, rm-rf'ing
  `installed-hooks/<id>/`, and appending a `{action:"uninstall"}`
  line to `pending-hooks.ndjson`. Validated under
  `CLAUDE_CONFIG_DIR=/tmp/...`: 33/33 real assertions pass across
  shadow/stable dry-run + real archive (stable uninstall
  observed), FSM rejection of vetoed→archived and
  archived→archived, **archive-vs-veto semantic contrast
  (vetoed-ids.json byte-identical before/after archive)**, and
  real `~/.claude` zero pollution.
- **DONE (Phase 19, /evolve-tick auto-path dry-run side-effect preview)**:
  Completes the dry-run trifecta — after Phase 16 (`/evolve-accept`)
  and Phase 17/18 (`/evolve-veto`, `/evolve-archive`) taught manual
  commands to preview Phase 14 loader artifacts, Phase 19 wires the
  same preview into the AUTO path. `/evolve-tick` (default `dryRun`,
  OR `--apply` downgraded because CLAUDE_EVOLVE=off) now appends a
  `### Phase 14 Side Effects Preview (dry-run only)` section that
  filters `applyAutoPromotions.decisions` for `action='promote' &&
  to='stable'` (renders install preview via
  `previewInstallKindIntoClaudeDirs(manifest, orgDir)`) and captures
  `applyAutoArchive` decisions with `from='stable'` (renders
  uninstall preview via `previewUninstallKindFromClaudeDirs`).
  Manifests are loaded at render-time via `readOrganism(d.from,
  d.organismId)` — `applyAutoPromotions`/`applyAutoArchive`
  signatures are NOT touched, preserving the existing engine API.
  Preview is suppressed under real `--apply && CLAUDE_EVOLVE=on`
  because side effects have already fired (preview would mislead).
  Validated under `CLAUDE_CONFIG_DIR=/tmp/...`: 29/29 real assertions
  pass across shadow→canary (no Phase 14 section for that decision,
  as expected), canary→stable (install preview with artifact paths),
  auto-stale stable→archived (uninstall preview with `-` lines),
  dry-run fs purity (installed-hooks intact, no early install), real
  `--apply` executes transitions without the preview section
  (installed-hooks/<id>/hook.sh appears on stable entry and is
  removed on archive), real `~/.claude` zero pollution.
- **DONE (Phase 20, /evolve-install-hook semi-automatic settings.json merge)**:
  Closes the last-mile reviewer friction — Phase 14 leaves the
  hook script under `installed-hooks/<id>/` and queues a row in
  `pending-hooks.ndjson`, but `settings.json` is user-root
  permission and autoEvolve never mutates it unsupervised. Phase 20
  adds `/evolve-install-hook <id> [--dry-run] [--remove] [reason...]`
  which semi-automates that last step: install path merges
  `{type:'command', command}` into
  `settings.json.hooks[event][matcher].hooks` via the existing
  `updateSettingsForSource('userSettings', ...)` atomic writer
  (cache-invalidation + validation reuse inherited), and remove
  path uses the newly-added autoEvolve-owned
  `installed-settings.ndjson` audit ledger (not settings.json
  itself) as reverse-map authority — so merged entries stay
  byte-identical to user-written entries (no sentinel pollution),
  and `--remove` on a reviewer-renamed command reports
  `hand-modified` rather than guessing. Idempotent:
  repeat-install → `already-present`, repeat-remove → `nothing-to-remove`.
  Preserves any user-written hooks in the same event/matcher; auto-cleans
  empty matchers + empty events on remove. `--dry-run` is strictly read-only.
  Validated under `CLAUDE_CONFIG_DIR=/tmp/...`: 38/38 real assertions
  pass across dry-run install (settings + ledger byte-identical), real
  install (autoEvolve hook appears, user-owned hook preserved, ledger
  appends `action='merge'`), idempotent re-install, dry-run + real
  remove (user hook still present, ledger appends `action='unmerge'`),
  `nothing-to-remove` after prior unmerge, `hand-modified` detection
  when reviewer renames the command (no splice happens), and real
  `~/.claude/settings.json` zero pollution.
- **DONE (Phase 21, /evolve-archive --purge-settings chain)**:
  Closes the archive-to-settings orphan loop. Phase 18 cleaned
  `installed-hooks/<id>/` and `pending-hooks.ndjson` on
  `stable→archived`, but `settings.json` entries pointing at the
  now-removed hook.sh were left as orphans on disk — reviewers had
  to remember to follow up with `/evolve-install-hook <id> --remove`.
  Phase 21 adds an opt-in `--purge-settings` flag to `/evolve-archive`
  that chains the exact same `removeHookFromSettings(id, rationale)`
  **after** the archive commit. Default OFF preserves Phase 18's
  original semantics; the chain only fires on `kind=hook &&
  fromStatus=stable` (other combos print a no-op rationale). Chain
  rationale includes `auto-chain from /evolve-archive` so the
  `installed-settings.ndjson` audit ledger can be filtered by source
  command later. Hand-modified detection from Phase 20 propagates
  through: a reviewer-renamed command produces
  `reason=hand-modified` and is left alone with a warning — the
  chain never guesses-and-deletes. Settings removal failure does
  NOT roll back the archive (same "real effect trumps audit"
  discipline as Phase 14 install/uninstall). `--dry-run
  --purge-settings` renders the Phase 14 uninstall preview AND a
  `Phase 21 --purge-settings (preview)` block in one shot, with
  both sections touching zero disk state. Validated under
  `CLAUDE_CONFIG_DIR=/tmp/...`: 43/43 real assertions pass across
  dry-run with and without flag (settings + ledger byte-identical),
  real archive without flag (orphan preserved, Phase 18 behavior
  unchanged), real archive with flag (settings entry removed,
  user-owned hooks preserved, ledger append carries `auto-chain`
  rationale), kind≠hook and fromStatus≠stable no-op paths,
  reviewer-renamed command hand-modified path (archive commits but
  settings are left alone), and real `~/.claude/settings.json` zero
  pollution.
- **DONE (Phase 22, Goodhart Guard anti-cheat)**: plugs a Goodhart's-law
  safety net in front of the auto-promotion decision path.
  `oracle/goodhartGuard.ts` exposes `detectCheating(manifest, status, opts?)`
  and runs four orthogonal rules against each organism before
  `per_org_adverse` fires: **R1 trivial-body** (non-prompt organism's body
  has <64 non-whitespace chars — catches empty `hook.sh` / stub
  `SKILL.md`), **R2 flat-dimensions** (≥80% of the organism's contributing
  FitnessScores have 4-way-equal dims across ≥5 trials — catches Oracle
  scorers pressed flat), **R3 sudden-jump** (time-sorted contributing
  scores of length ≥6 split half-and-half as ≤0 → ≥0.8 — catches
  "trained-against-the-oracle" step functions), **R4 perfect-record**
  (trials≥10 + losses=0 + avg≥0.95 — reality always has tool retries /
  user corrections, frictionless means fabricated). Positioned BEFORE
  `per_org_adverse` in `decide()` on purpose: `wins/losses` statistics
  derived from gamed scores would themselves be misleading, so Goodhart
  screens the raw signal first. Verdicts surface three ways: (a)
  `PromotionDecision.action='hold'` with reason prefix
  `goodhart_veto: <rules> [bodyBytes=… trials=… avg=…]`, (b)
  `PromotionDecision.metrics.goodhartReasons: GoodhartReason[]` for
  `/evolve-status` rendering, (c) an auditable append to
  `oracle/goodhart.ndjson` (Phase 12 rotation) with full metrics
  snapshot. Manual `/evolve-accept` deliberately bypasses the guard —
  reviewer judgment is authoritative by design. `detectCheating` is a
  pure read function whose `scoresOverride / bodyBytesOverride /
  aggregateOverride / skipAudit` hooks make it single-unit testable
  without any ledger setup. Validated under
  `CLAUDE_CONFIG_DIR=/tmp/autoevolve-phase22-validate/home`: 65/65 real
  assertions pass across 7 scenarios: (A) direct `detectCheating` on
  five real on-disk manifests (four cheaters + one honest), (B)
  full-path wiring through `evaluateAutoPromotions` (four organisms
  held with matching `goodhartReasons`, honest organism promoted to
  canary, `gatedByOracle=false` so isolation is clean), (C) audit
  ledger presence (four cheaters written, honest absent, ISO `at`,
  reasons array, kind + status carried), (D) pure-function override
  path, (E) multi-rule concurrent firing (`trivial-body + flat-dimensions`
  coexist in `detail`), (F) per-rule boundary checks
  (`bodyBytes == MIN_BODY_BYTES` does NOT trigger R1; R2 at `trials=4 <
  FLAT_DIMS_MIN_TRIALS`, R3 at `len=5 < JUMP_MIN_LEN`, R4 at `trials=9 <
  PERFECT_MIN_TRIALS`, `losses=1`, `avg=0.94` all correctly skip; `kind=prompt`
  bypasses R1 entirely), (G) `detail` string format regression
  (`goodhart_veto:` prefix, `bodyBytes=N`, `trials=N`, `avg=0.NN`, comma-joined
  multi-reasons).
- **DONE (Phase 23, /evolve-status + settings / goodhart panels)**: makes
  reviewer feedback loops on Phase 20 (settings.json hook installs) and
  Phase 22 (anti-cheat vetoes) *visible* from the main diagnostic
  panel — previously both ledgers lived only on disk. Adds two new
  exports to `arena/settingsHookInstaller.ts`:
  `listCurrentlyMergedTargets()` replays the installed-settings ledger
  once to produce a `Map<organismId, target>` of all hooks currently
  in the merged state (unmerged entries drop out, zero I/O amplification
  vs looping `findLatestMergedTarget`); `detectSettingsDrift()` pairs
  each merged target against the live `~/.claude/settings.json` hooks
  block and marks `present=false` when the `(event, matcher, command)`
  tuple is missing (hand-modified drift). Wired into `/evolve-status`
  as two new sections positioned before Paths: **Installed Settings
  Snapshot (Phase 23)** renders `total merged / intact / hand-modified`,
  lists each entry with a marker (`  ` intact vs `!` hand-modified),
  shows empty matchers as `(empty)`, prints the command under each row,
  adds an explanatory warning + `/evolve-install-hook --remove` hint for
  each hand-modified entry; **Recent Goodhart Vetoes (Phase 22)** tails
  `goodhart.ndjson` in reverse-chronological order (default limit 10),
  prints `[organismId] kind=… status=… reasons=[…]`, then a metrics
  line (`bodyBytes / trials / losses / avg / flatFrac / firstAvg /
  secondAvg`), and aggregates a `rule frequency` summary at the bottom
  so the reviewer instantly knows which of R1-R4 is loudest. Paths
  section extended with absolute locations of both ledgers. All in
  individual try/catch blocks — consistent with the existing "one
  section failing never poisons the panel" discipline. Validated under
  `CLAUDE_CONFIG_DIR=/tmp/autoevolve-phase23-validate/home`: **44/44**
  real assertions pass across 7 scenarios: (A) empty-state rendering
  for both sections, correct title bump, Paths carries two new rows;
  (B) `listCurrentlyMergedTargets` state machine (merge → unmerge
  correctly drops from map, second merge persists); (C)
  `detectSettingsDrift` intact + hand-modified: writes a real
  `settings.json`, resets settings cache via
  `utils/settings/settings.js#resetSettingsCache`, asserts `present=true`
  for matching tuples and `present=false` when the command was renamed
  (`/path/to/gamma.sh` → `/path/to/renamed-gamma.sh`); (D) panel
  rendering of the drift result (correct marker placement, aggregate
  counts, Tip line, `(empty)` matcher display); (E) Goodhart panel
  rendering with 3 seeded vetoes (reverse-chronological order, metrics
  line format, `n/a` for null `firstHalfAvg/secondHalfAvg`, rule
  frequency aggregate across all 4 rule names); (F) defensive rendering
  when a ledger line is missing `kind` (displays `kind=?` instead of
  crashing); (G) bad-JSON lines + entries missing `reasons` are skipped
  by `recentGoodhartVetoes` without breaking the panel. Real end-to-end
  smoke against the Phase 22 fixture directory shows both sections
  populated with live data (rule frequency
  `sudden-jump=3 perfect-record=3 flat-dimensions=2 trivial-body=2`).
- **DONE (Phase 24, threshold auto-tuner + /evolve-tune)**: replaces the
  four hardcoded decision thresholds
  (`ORACLE_ADVERSE_AVG_THRESHOLD=-0.5`, `ORGANISM_WIN_THRESHOLD=0.3`,
  `ORGANISM_LOSS_THRESHOLD=-0.3`, `PERFECT_AVG_MIN=0.95`) with a JSON
  snapshot at `oracle/tuned-thresholds.json` read through
  `loadTunedThresholds()` — mtime-cached, field-level fallback to
  defaults on corrupt/partial JSON so half-edited files never crash the
  decide path, `saveTunedThresholds()` invalidates the cache on write.
  New module `services/autoEvolve/oracle/thresholdTuner.ts`:
  `computeTuningSuggestion(windowDays=30)` walks the recent
  `fitness.ndjson` window, splits positive/negative scores, derives
  percentile-based recommendations via a pure linear-interpolation
  `percentile()` helper (p10 of negatives → `oracleAdverseAvg`, p25/p75
  of the mixed distribution → `organismLoss/Win`, p95 of positives →
  `goodhartPerfectAvgMin`), clamps each to a safe range
  (`oracleAdverseAvg∈[-1,-0.1]`, win∈[0.1,0.8], loss∈[-0.8,-0.1],
  perfect∈[0.9,0.99]), returns `insufficientReason` when `<
  MIN_SAMPLES_FOR_TUNE (10)` so downstream can degrade gracefully.
  Three consumer wirings (all call-time reads, no boot-time
  crystallisation — so `--apply` propagates instantly via mtime cache
  invalidation, no service restart required):
  `autoPromotionEngine.ts` threads a new optional
  `oracleAdverseAvgThreshold` param through `decide()` (default equals
  the exported constant, backwards-compatible with any 3-arg caller);
  `evaluateAutoPromotions()` loads `tuned.oracleAdverseAvg` and passes
  it through to both the `gatedByOracle` check and `decide()`.
  `oracleAggregator.ts` reads `tuned.organismWinThreshold/organismLossThreshold`
  at the top of `aggregateOrganismFitness()` and `aggregateAllOrganisms()`
  (before the bucket loop), and `bucketScore()` reads at call time.
  `goodhartGuard.ts` R4 (perfect-record) reads
  `tuned.goodhartPerfectAvgMin` at check time. Reviewer command
  `/evolve-tune [--apply] [--window DAYS] [--reset]` at
  `commands/evolve-tune/index.ts`: default dry-run prints an aligned
  `name / current / suggested / delta` table plus per-row rationale
  without writing disk; `--apply` persists `suggestionToNext(s)` through
  `saveTunedThresholds()` and auto-skips when `insufficientReason` is
  set (prevents low-data environments from clobbering previously-good
  tuned values); `--reset` `unlinkSync`s the JSON + invalidates the
  cache so consumers fall back to `DEFAULT_TUNED_THRESHOLDS`;
  `--window` clamped 1..365; `--apply` and `--reset` are mutually
  exclusive. Command registered in `src/commands.ts` after
  `evolveInstallHook`. New path helper
  `paths.ts#getTunedThresholdsPath()`. Exported constants
  (`ORACLE_ADVERSE_AVG_THRESHOLD`, `ORGANISM_WIN_THRESHOLD`, etc.) kept
  as compat defaults so out-of-tree importers don't break. Validated
  under `CLAUDE_CONFIG_DIR=/tmp/autoevolve-phase24-validate/home`:
  **67/67** real assertions pass across 7 scenarios: (A) percentile
  helper + default constants (10 checks), (B) load/save round-trip +
  mtime cache + field-level fallback for partial/corrupt JSON (13
  checks), (C) insufficient-data degradation path with
  `suggested==current` (5 checks), (D) full-distribution tuning with 20
  seeded scores + out-of-window record filtering (10 checks), (E)
  consumer modules pick up tuned values (`bucketScore` tuned,
  `goodhartGuard` R4 with `avg=0.93` flipping veto/allow as
  `perfectAvgMin` flips 0.95↔0.9, `autoPromotionEngine` gated by tuned
  `oracleAdverseAvg`, 7 checks), (F) `/evolve-tune` command dry-run /
  `--apply` / `--reset` / `--window` parsing + error handling (22
  checks).
- **DONE (Phase 25, real git worktree spawn)**: replaces the Phase 1
  `spawnOrganismWorktree` stub with a real `git worktree add`
  implementation. Each organism now maps to a dedicated worktree at
  `<CLAUDE_CONFIG_DIR>/autoEvolve/arena/worktrees/<id>/` on branch
  `autoevolve/organism-<id>` (forked from `HEAD`), so downstream phases
  can attribute sessions running inside that worktree directly to the
  organism instead of going through the `session-organisms.ndjson`
  reverse-lookup. Still gated behind `CLAUDE_EVOLVE_ARENA=on` —
  default off, stub-safe; when enabled the function returns
  `{attempted, success, reason, worktreePath?, branch?}` and covers
  five paths: (a) fresh spawn creates branch+worktree in one call,
  (b) idempotent re-spawn — if the target path is already registered
  with `git worktree list --porcelain` (comparison uses `realpathSync`
  on both sides to defeat macOS `/tmp` ↔ `/private/tmp` symlink
  mismatch — was a real bug caught by validation), (c) branch-reuse —
  if a prior cleanup only removed the worktree but left the branch,
  fall back to `git worktree add <path> <branch>`, (d) refuse-to-
  overwrite — if the directory exists but is NOT a registered worktree
  (reviewer / user files), fail with reason instead of nuking, (e)
  graceful degradation — `cwd` not a git repo or `git` binary missing
  surfaces stderr as `reason`, no throw. Companion
  `cleanupOrganismWorktree(id)` is a tri-stage sweep: `git worktree
  remove --force` → `git branch -D autoevolve/organism-<id>` →
  residual `rmSync`, with branch-delete failure NOT flipping success
  to false when the worktree itself is gone (fixes the "auto-gc after
  user manually cleaned" corner). New path helpers
  `paths.ts#getArenaWorktreesDir()` + `getArenaWorktreeDir(id)` keep
  the path math one-liner. Exported stub signature extended from 3
  fields to 5 (added optional `worktreePath` / `branch`) so existing
  callers destructuring only the first 3 keep working. Validated under
  `CLAUDE_CONFIG_DIR=/tmp/autoevolve-phase25-validate/home` against a
  real `git init` repo: **47/47** real assertions across 9 scenarios
  A-J: (A) gate-OFF stub-safety (5 checks), (B) fresh spawn creates
  worktree + branch visible in `git worktree list` and `git branch`
  (8 checks), (C) idempotent re-spawn returns same path without
  creating a duplicate worktree (4 checks), (D) second organism spawns
  independently, both branches coexist (4 checks), (E) cleanup removes
  path + branch but leaves the other organism alone (6 checks), (F)
  cleanup of never-spawned id is idempotent success (3 checks), (G)
  residual-branch re-spawn reuses the orphan branch (4 checks), (H)
  refuse-to-overwrite path that has user files but isn't a worktree (4
  checks), (I) non-git cwd graceful failure (3 checks), (J) final
  cleanup leaves no autoevolve branches behind (3 checks). Script at
  `/tmp/autoevolve-phase25-validate/run.ts` with real `git init` + real
  `git worktree` commands — no mocks, no headless shortcuts.
- **DONE (Phase 26, FitnessScore.organismId 直接归属)**: closes the
  Phase 7 session-to-organism reverse-attribution gap by introducing a
  direct-attribution path alongside the existing reverse lookup.
  `spawnOrganismWorktree` now writes `.autoevolve-organism` at the
  worktree root (single-line plain text = organism id, via new helper
  `ensureOrganismMarker` — idempotent: no-op if marker already matches,
  overwrite if it drifted; write-failure stays on the `reason` line but
  does NOT flip spawn success). New `paths.readOrganismMarker(startDir)`
  walks up ≤32 directory levels from any cwd; stops at filesystem root;
  swallows read errors silently so callers on the hot path (Dream
  converge) don't pay for ENOENT. `FitnessInput` + `FitnessScore` both
  gain optional `organismId?: string`; `scoreSubject` propagates it via
  conditional spread (`...(input.organismId ? { organismId } : {})`) —
  pre-Phase-26 rows in `fitness.ndjson` stay bit-exact, no migration.
  `observeDreamEvidence` (the single writer in the fitnessObserver
  bridge) reads the marker via `process.cwd()` at score time — when the
  session runs inside an arena worktree, the id is attributed directly;
  outside worktree, field is left undefined and Phase 7 reverse lookup
  takes over. `oracleAggregator.aggregateOrganismFitness` +
  `aggregateAllOrganisms` both now union the two paths: per-score `hits
  = Set<organismId>` includes `score.organismId` (direct) ∪
  `sessionToOrganisms.get(score.subjectId)` (reverse); the Set de-dup
  prevents double-counting when both paths hit the same score. The
  Phase 7 early-exits `if (links.length === 0) return empty` and
  `if (sessionSet.size === 0) return empty` were removed from
  `aggregateOrganismFitness` so a never-reverse-linked organism with
  only direct scores still aggregates correctly — caught by validation
  as an E1-trials=0 regression and fixed same-session. Validated under
  `CLAUDE_CONFIG_DIR=/tmp/autoevolve-phase26-validate/home` against
  real `git init` repo + real fitness + aggregator calls: **28/28**
  real assertions across 9 scenarios A-I: (A) spawn writes marker with
  matching content (3 checks), (B) `readOrganismMarker` hits at
  worktree root, at nested subdir (walk-up), returns null outside
  worktree (3 checks), (C) `scoreSubject` propagates organismId or
  leaves it undefined (4 checks), (D) `observeDreamEvidence` injects
  when cwd is worktree / omits when cwd is not (4 checks), (E)
  `aggregateOrganismFitness` direct-only path without any session
  link (3 checks — the bug catch), (F) Phase 7 reverse-only fallback
  still works (2 checks), (G) dual-path same-score counted once (2
  checks), (H) `aggregateAllOrganisms` covers all 3 organisms
  including the dedup case (4 checks), (I) idempotent re-spawn
  preserves marker content (3 checks). Script at
  `/tmp/autoevolve-phase26-validate/run.ts` with real
  `recordSessionOrganismLink` + real `scoreSubject` + real `agg.*` —
  no mocks, no short-circuits.
- **DONE (Phase 27, Oracle meta-evolver + /evolve-meta)**: replaces the
  hardcoded 4-dim Oracle weights (0.4/0.3/0.15/0.1) with an SNR-based
  auto-tuner. New module `services/autoEvolve/oracle/metaEvolver.ts`
  exports `TunedOracleWeights` (`version:1` + `updatedAt` + 4 weights —
  deliberately no `safetyVetoEnabled`, since safety is a veto switch
  and must never be tuned), `DEFAULT_TUNED_ORACLE_WEIGHTS` (= the 4-dim
  subset of `DEFAULT_ORACLE_WEIGHTS`), `WEIGHT_MIN=0.05`, `WEIGHT_MAX=0.7`,
  and `MIN_SAMPLES_FOR_META=20`. `loadTunedOracleWeights()` is
  mtime-cached and — unlike `thresholdTuner.loadTunedThresholds` which
  returns defaults when the file is missing — returns **`null`** when
  `tuned-oracle-weights.json` does not exist, so the caller can
  distinguish "fall through to base/DEFAULT" from "use tuned". Partial
  / corrupt JSON falls back field-by-field to `DEFAULT_TUNED_ORACLE_WEIGHTS`
  rather than being wholesale-discarded. `saveTunedOracleWeights(next)`
  clamps every field on write and invalidates the cache. Core function
  `computeWeightSuggestion(windowDays=30)` pulls `recentFitnessScores(2000)`,
  filters by window, reads Phase 24 tuned win/loss thresholds (aligning
  metaEvolver's bucket semantics with `oracleAggregator.bucketScore` so
  a win in one is a win in the other), computes per-dimension
  `SNR = |mean(win) - mean(loss)| / (std(all) + 1e-6)`, normalizes
  proportional to SNR, clamps to `[0.05, 0.7]`, and re-normalizes;
  post-clamp floor/ceiling fixup ensures strict bounds. Below
  `MIN_SAMPLES_FOR_META` every row degrades to `suggested = current` +
  `insufficientReason` populated; `/evolve-meta --apply` refuses to
  write in that case, protecting any pre-existing tuned snapshot.
  Rationale strings classify by SNR tier (`≈0 → floor`, `<0.2 → shrink`,
  `<0.6 → standard`, `≥0.6 → boost`). `suggestionToNext(s)` converts a
  suggestion to a ready-to-save `TunedOracleWeights`.
  `loadOracleWeights()` in `fitnessOracle.ts` now follows a 3-layer
  priority: tuned (via a dynamic `require('./metaEvolver.js')` to
  avoid the mutual import of `fitnessOracle ↔ metaEvolver`) → base
  `weights.json` → `DEFAULT_ORACLE_WEIGHTS`; `safetyVetoEnabled` always
  flows through from the base layer (tuned has no safety field), and
  the resulting `version` string is `<base>+tuned@<updatedAt>` for
  audit traceability. New command `/evolve-meta [--window DAYS] [--apply] [--reset]`
  at `commands/evolve-meta/index.ts` mirrors the Phase 24 `/evolve-tune`
  pattern: dry-run prints aligned `name / current / suggested / delta / SNR`
  table plus per-row rationale plus a line reminding readers that
  safety is a VETO (never tuned); `--apply` persists + invalidates
  cache so `scoreSubject` picks up new weights on next call without a
  service restart; `--reset` `unlink`s only the tuned snapshot (base
  `weights.json` is user-owned and never touched by this command).
  Registered in `commands.ts` next to `evolveTune`. Validated under
  `CLAUDE_CONFIG_DIR=/tmp/autoevolve-phase27-validate/home` against
  real `git init` repo + real 35-score `fitness.ndjson` + real
  `loadOracleWeights` cascade: **34/34** real assertions across 8
  scenarios A-H: (A) insufficient-data degradation with 5 samples
  (4 checks), (B) SNR recommendation with taskSuccess engineered to
  discriminate win/loss strongly while userSatisfaction stays flat
  → taskSuccess SNR > userSatisfaction SNR and taskSuccess suggested
  > userSatisfaction suggested (6 checks), (C) every row within the
  `[0.05, 0.7]` clamp (4 checks), (D) `saveTunedOracleWeights` →
  tuned-oracle-weights.json on disk + mtime-cached reload matches
  (5 checks), (E) 3-layer priority: tuned over base over DEFAULT
  across three states (tuned+base, base-only, neither) with distinct
  taskSuccess values (0.34 base vs 0.3 DEFAULT) (6 checks), (F)
  `touchedForbiddenZone` still produces `score=-1` after tuning
  (safety veto intact) (2 checks), (G) partial tuned JSON (missing
  `codeQuality`) falls back field-level to DEFAULT rather than being
  discarded (3 checks), (H) explicit `unlink` → `loadTunedOracleWeights`
  returns `null` (1 check). Script at
  `/tmp/autoevolve-phase27-validate/run.ts` seeds real `scoreSubject`
  calls (no synthetic ndjson writes) — no mocks, no short-circuits.
- **DONE (Phase 28, Oracle-level anti-Goodhart + /evolve-bench)**: closes the
  loop opened by Phase 22 (per-organism anti-cheat) at the Oracle level —
  prevents metaEvolver (Phase 27) + thresholdTuner (Phase 24) from
  co-optimizing Oracle into a "looks great on current data but has quietly
  drifted off what the user actually cares about" state. New module
  `services/autoEvolve/oracle/benchmarkLedger.ts` exports
  `BenchmarkEntry` (id / description / acceptanceCriteria / createdAt /
  createdBy — user-defined canonical tasks), `BenchmarksFile` (`version:1`),
  `BenchmarkRun` (runId / benchmarkId / organismId? / at /
  oracleWeightsVersion / score / dimensions? / signature), `readBenchmarks()`
  (mtime-cached, field-level skip of malformed rows), `addBenchmark()`
  (id regex `/^[A-Za-z0-9_-]{1,64}$/`, non-empty description, createdAt
  preserved on id collision — prevents "user re-registers for typo fix"
  from losing original timestamp), `appendBenchmarkRun()` (auto runId /
  signature via SHA-256, goes through Phase 12 `appendJsonLine` so it
  inherits 10MB rotation), `recentBenchmarkRuns(limit=500)` (inline
  split+parse, structured so it cannot go through the Phase 26 organism
  attribution path — benchmarks never contaminate organism rankings).
  Two new paths in `paths.ts`: `getBenchmarksPath()` → user-editable
  `oracle/benchmarks.json`, `getBenchmarkRunsPath()` → append-only
  `oracle/benchmark-runs.ndjson`. Core audit function
  `computeDrift({ windowRuns=500, driftThreshold=0.3, minSuspiciousBenchmarks=3 })`
  groups runs by benchmarkId then oracleWeightsVersion, computes pairwise
  mean deltas between versions, flags rows where `|meanA - meanB| >
  driftThreshold`, and only returns `suspicious=true` when the set of
  drifted-benchmarks hits `minSuspiciousBenchmarks` — chose "many
  benchmarks simultaneously drift" over "one benchmark drifts hard"
  because noisy reviewer scoring on a single benchmark shouldn't lock
  out `/evolve-meta --apply`. Insufficient data (no runs, or every
  benchmark has only one version) returns `suspicious=false` with a
  clear `reason` string (`insufficient data: need ≥2 oracleWeightsVersion
  per benchmark to compare`), so first-time users are not blocked.
  New command `/evolve-bench <--list | --add | --record | --drift>` at
  `commands/evolve-bench/index.ts`: `--list` reads registry and prints
  all benchmarks with description + acceptance criteria; `--add <id>
  --desc "..." [--criteria "..."]` registers (or overwrite-description)
  a benchmark, rejecting malformed id / empty description;
  `--record --id <benchmarkId> --score <n> [--organism <id>]
  [--weights-version <str>]` appends a run (weights-version defaults to
  `loadOracleWeights().version` at record time — snapshot of the
  scoring regime — so drift detection sees the real transition edges);
  `--drift [--threshold 0.3] [--min-benchmarks 3] [--window 500]`
  prints an aligned `benchmarkId / versionA / versionB / meanA / meanB /
  Δ / susp?` table plus the `reason` line. All four subcommands are
  mutually exclusive; unknown benchmark id on `--record` is rejected
  with a clear remediation hint. `/evolve-meta` gains a `--force` flag
  and now runs `computeDrift()` inside `--apply` **after**
  insufficient-data check but **before** `saveTunedOracleWeights()`:
  if drift is suspicious and `--force` is absent, `--apply` refuses
  to write tuned weights and prints the suspicious rows + remediation
  hint (`re-run with --apply --force` if the drift is intentional);
  `--force` acknowledges the drift and still writes.
  Registered `evolveBench` in `commands.ts` next to `evolveMeta`.
  Validated under `CLAUDE_CONFIG_DIR=/tmp/autoevolve-phase28-validate/home`
  against a real `git init` repo + real `scoreSubject` seed + real
  `benchmarks.json` + real `benchmark-runs.ndjson`: **35/35** real
  assertions across 9 scenarios A-I: (A) empty registry path —
  `readBenchmarks` returns `{version:1, benchmarks:[]}` and
  `/evolve-bench --list` prints friendly "no benchmarks yet" message
  (3 checks), (B) `addBenchmark` write+read-back, id-collision
  preserves original `createdAt` while overwriting description,
  malformed id and empty description rejected (9 checks),
  (C) `appendBenchmarkRun` → signature / runId / read-back score
  match (5 checks), (D) `computeDrift` three-tier: single-version →
  insufficient, single-benchmark drift → not suspicious, three-benchmark
  drift → suspicious=true with suspiciousRows covering all three
  (6 checks), (E) `/evolve-meta --apply` blocked with clear drift-gate
  message and tuned file not written (2 checks), (F) `--apply --force`
  overrides the gate, tuned file written, output contains "overridden
  via --force" (2 checks), (G) `benchmark-runs.ndjson` and
  `fitness.ndjson` live at distinct paths and never cross-pollute
  (every bench line has `benchmarkId`, every fitness line does not)
  (2 checks), (H) `/evolve-bench --record` with unknown id rejected
  with remediation hint, missing `--id`/`--score` rejected (2 checks),
  (I) `/evolve-bench --drift` prints report with benchmark drift
  title, suspicious **YES** marker, and ≥3 matching table rows
  (3 checks). Script at `/tmp/autoevolve-phase28-validate/run.ts`
  drives the real command `call()` functions — no mocks, no
  ndjson forging, no short-circuits.
- **DONE (Phase 29, 自动挖掘候选 benchmark)**: closes Phase 28 cold-start — instead
  of asking reviewers to guess which subjects deserve canonical-benchmark status,
  mine `fitness.ndjson` for the ones whose scoring is most sensitive to Oracle
  weight changes, then propose them. New export `mineBenchmarkCandidates()` in
  `services/autoEvolve/oracle/benchmarkLedger.ts`: inline-reads the tail of
  `fitness.ndjson` (default `windowLines=2000`; bypasses Phase 26
  `recentFitnessScores(limit=20)` which is too small to mine), groups rows by
  `subjectId`, tracks per-version score buckets, computes `maxVersionDelta`
  (`max(meanByVersion) - min(meanByVersion)`), `meanScore`, `extremity`
  (`|meanScore|`), and a combined `informativeness` score
  (`0.5 · min(Δ, 1) + 0.3 · extremity + 0.2 · min(log10(samples+1)/2, 1)`).
  OR-filter: a subject is retained if **either** `maxVersionDelta ≥ minDelta`
  (default 0.3) OR `extremity ≥ minExtremity` (default 0.5) — so
  single-version but decisive subjects (loud winners/losers) get in alongside
  weight-sensitive multi-version subjects. `suggestedId` = `mined-` +
  id-safe slug of subjectId (≤48 chars) — guaranteed distinct namespace so
  reviewer can `/evolve-bench --add <suggestedId>` without colliding with
  their handwritten ids; by default `excludeRegistered=true` skips any
  suggestedId already in `benchmarks.json` so the miner doesn't re-propose
  subjects the reviewer already accepted. Pure read-only: no writes to
  `benchmarks.json`, no writes to `benchmark-runs.ndjson`, no writes to
  `fitness.ndjson`; the reviewer still runs `/evolve-bench --add` to register
  a candidate. Only the miner is allowed to cross the Phase 28 path-isolation
  boundary from benchmarkLedger → fitness.ndjson, because it needs the full
  cross-Oracle-version signal; this single read path is deliberate and
  documented in the header comment. New subcommand
  `/evolve-bench --mine [--top 10] [--window 2000] [--min-delta 0.3]
  [--min-extremity 0.5] [--include-registered]` prints a ranked table
  (`#  suggested-id  info  Δver  mean  n  rationale`) plus a mapping
  footer (`suggestedId ← subjectId=... organismId=...`) so the reviewer
  can trace each suggestion back to its source session. `rationale`
  field packs all three signals into one human-readable line
  (e.g., `3 oracleVersion(s), Δ=1.40 (sensitive to weight-tuning);
  mean=-0.80 (decisive loss); n=6`). `--window` token is shared with
  `--drift` (same ParsedFlags.driftWindow — both are "how many lines to
  look back", no reason to duplicate). Validated under
  `CLAUDE_CONFIG_DIR=/tmp/autoevolve-phase29-validate/home` against real
  git repo + real `fitness.ndjson` (hand-written 12 lines covering 3
  subject archetypes: weight-sensitive `hero-subj`, decisive-winner
  `decisive-winner-uuid-abc`, noise `noisy-sample`): **27/27** real
  assertions across 10 scenarios A-J: (A) empty ledger → scanned=0,
  candidates=[], reason non-empty (3), (B) real mining: scanned=12,
  hero + decisive-winner both hit, noisy-sample filtered (3), (C)
  suggestedId id-safe + `mined-` prefix (4), (D) hero Δ>1, two
  oracleVersions, informativeness descending order, hero ranked above
  decisive-winner because cross-version Δ outranks single-version
  extremity (4), (E) excludeRegistered=true default hides registered
  ids, =false restores them (2), (F) topK=1 returns exactly 1 (1),
  (G) `/evolve-bench --mine --include-registered --top 5` shows
  title/scanned/hero suggestedId/`--add` hint (4), (H) empty fitness
  after delete → command prints `candidates: 0` with `note:` line (2),
  (I) miner read-only: benchmarks.json + benchmark-runs.ndjson
  unchanged across a mine call (2), (J) infeasibly high thresholds
  (minDelta=5, minExtremity=5) → candidates empty with reason (2).
  Script at `/tmp/autoevolve-phase29-validate/run.ts` drives
  `mineBenchmarkCandidates()` directly and through real
  `/evolve-bench --mine` command `call()` — no mocks.
- `goodhartGuard.ts` — Phase 22 shipped per-organism anti-cheat (R1-R4);
  Phase 28 shipped Oracle-level anti-Goodhart (benchmark regression);
  Phase 29 closes cold-start by auto-mining candidate benchmarks from
  fitness.ndjson. No further Goodhart-layer work queued — reviewer can now
  go from empty registry → curated canonical set in one `/evolve-bench
  --mine` → review → batch `--add` pass.
- **DONE (Phase 30, 并行多-arena worktree)**: closes the Phase 25 single-arena
  bottleneck — a proposal batch can now spawn multiple isolated git worktrees
  in one call, freeing shadow/canary testing from sequential wall-clock cost.
  New exports in `services/autoEvolve/arena/arenaController.ts`:
  `spawnOrganismWorktreesBatch(ids, opts?)` returns a `SpawnBatchResult`
  (`attempted / reason / entries[] / capHit?`) where each entry mirrors the
  existing `spawnOrganismWorktree` shape; `cleanupOrganismWorktreesBatch(ids)`
  returns a parallel `CleanupBatchResult`; `listActiveArenaWorktrees()` scans
  `arena/worktrees/<id>/` and reports `{id, worktreePath, markerExists}` with
  stable id-sorted output. `MAX_PARALLEL_ARENAS=8` is the hard cap — the
  batch function projects `active_before + new_ids` and **refuses the whole
  request** (entries=[], `capHit` populated with
  `{activeBefore, requested, cap}`) when that total would exceed either the
  user-supplied `maxParallel` (clamped to [1, 8]) or the hard cap. Refusing
  whole-hog is deliberate: half-spawning would leave the caller guessing which
  ids made it and risks resource leaks. Per-id spawn still calls the existing
  `spawnOrganismWorktree` serially (so git `index.lock` stays uncontested — the
  "parallel" in Phase 30 refers to post-spawn concurrent worktree
  **availability**, not concurrent git invocations); single-id failures don't
  contaminate siblings. Input sanitization: empty / whitespace-only ids
  skipped, duplicates collapsed to first-seen order. `listActiveArenaWorktrees()`
  is intentionally read-only and works even when `CLAUDE_EVOLVE_ARENA` is off —
  this lets the reviewer audit historical residue after disabling the flag
  without re-enabling it just to peek. `markerExists=false` flags stale
  residue (e.g., crashed spawn that wrote a dir but no marker), which the
  `--list` command surfaces with a hint to `--cleanup-all`. New command
  `/evolve-arena <--list | --spawn ids... [--max-parallel N] | --cleanup ids... | --cleanup-all>`
  at `commands/evolve-arena/index.ts`: strictly mutually-exclusive modes,
  `--list` always read-only (even when arena flag off), `--spawn/--cleanup`
  require at least one id, `--cleanup-all` calls
  `cleanupOrganismWorktreesBatch(listActiveArenaWorktrees().map(a=>a.id))`
  for one-shot teardown, `--max-parallel` validated to 1..64 (then
  re-clamped to `MAX_PARALLEL_ARENAS` inside the batch function). Output
  shape: `--list` prints an aligned `id / marker / worktreePath` table plus
  stale-residue footer; `--spawn` prints per-entry `✓/✗` badge +
  `worktreePath` (or reason) + `branch:` line on success; `--cleanup` /
  `--cleanup-all` mirror the same badged format. Registered in
  `commands.ts`: import line adjacent to `evolveBench`, export in the
  `evolveArena` slot after `evolveBench`. Validated under
  `CLAUDE_CONFIG_DIR=/tmp/autoevolve-phase30-validate/home` against a real
  `git init`-ed repo with **51/51** real-disk assertions across 11 scenarios
  A-K: (A) `CLAUDE_EVOLVE_ARENA` off gates spawn/cleanup to attempted=false
  while keeping `--list` available (3); (B) arena on + batch spawn 3 ids →
  all three worktree dirs + `.autoevolve-organism` markers + dedicated
  `autoevolve/organism-<id>` branches exist (9); (C) listActiveArenaWorktrees
  returns 3 entries all markerExists=true (4); (D) maxParallel=2 + 3 ids →
  refused whole, entries=[], capHit populated correctly, no disk writes for
  any of the 3 rejected ids (5); (E) re-spawning an already-spawned id is
  idempotent-safe, marker still present (3); (F) dedup: mixed empty/
  whitespace/duplicate ids collapse to unique set (2); (G) cleanupBatch 3
  ids → all success, all worktree dirs gone (5); (H) `/evolve-arena --list`
  command shows title, `CLAUDE_EVOLVE_ARENA: on`, per-id rows, and `yes`
  marker column (4); (I) `/evolve-arena --spawn` prints batch output with
  per-id entries; `--max-parallel 0` rejected at parse time (3); (J)
  `/evolve-arena --cleanup-all` clears everything, second call emits
  "no active worktrees" (3); (K) usage errors: empty args / unknown flag /
  missing id all produce helpful error text (4). Script at
  `/tmp/autoevolve-phase30-validate/run.ts` drives both the batch functions
  and the real command `call()` via `evolveArenaCmd.load().call(args)` — no
  mocks, no git-shell forging, no short-circuits.
- **DONE (Phase 31, 跨 organism 知识迁移)**: closes the "每个 organism 从零起步"
  blind spot — a proposal can now see which **stable** organisms already own
  the same semantic territory and optionally borrow their primary body as a
  warm-start seed. New module `services/autoEvolve/arena/kinshipIndex.ts`
  exports two data helpers (`tokenize(text) → Set<string>` with EN + CJK
  stop-word filtering and char-level CJK splitting; `jaccard(a, b) → number`
  with empty-set safety) and two top-level APIs:
  `findKinStableOrganisms(proposalText, {topK?, minSimilarity?, includeManifestBody?}) → KinshipResult`
  scans every stable organism (via `listOrganismIds('stable')` +
  `readOrganism('stable', id)` — reuses Phase 1 arena storage, does not
  duplicate scanning), tokenizes `manifest.name + rationale + winCondition`
  (+ primary body when `includeManifestBody !== false`; body file picked by
  iterating `ALL_PRIMARY_FILENAMES` from `emergence/bodyRenderers.ts`) and
  returns `{matches: KinshipMatch[], scanned, reason?}` sorted by Jaccard
  similarity descending with `rationalePreview` / `bodyPreview` /
  `bodyFilename` / `bodyPath` attached for each match.
  `suggestSeedBody(proposalText, opts?) → SeedResult` wraps `findKin`
  with `topK=1` and, on success, prefixes the top kin's body with an
  audit-friendly HTML comment header
  `<!-- kin-seeded from stableId=X similarity=Y source=FILENAME -->`;
  when stable/ is empty, no kin clears `minSimilarity`, or the top kin has
  no primary body on disk, it returns `{seedBody: '', chosenKin, strategy: 'empty', reason}`
  so callers can fall back to a blank template (deliberately **not**
  falling back to `proposalText` itself — a proposal is a meta description,
  not a target body, and blending them pollutes the skill body). Defaults:
  `topK=5` (clamped to [1, 50]), `minSimilarity=0.1` (empirically tuned —
  0.2 turned out too strict against realistic body sizes; more stable than
  the initial intuition because token union grows linearly with body
  length), `includeManifestBody=true`. Module is **read-only**: it never
  writes to stable/, never touches ledgers, and is **independent of
  CLAUDE_EVOLVE_ARENA** (purely disk scanning, no git worktree side
  effects — same audit-at-any-time property as `listActiveArenaWorktrees`).
  New command `/evolve-kin <--match "<text>" | --seed "<text>"> [--top N] [--min-sim F] [--no-body]`
  at `commands/evolve-kin/index.ts`: strictly mutually-exclusive modes,
  proposal text assembled from non-flag tokens (quoted strings preserved
  via `tokens.match(/"[^"]*"|\S+/g)`), `--top` validated 1..50, `--min-sim`
  validated [0, 1], `--no-body` flips `includeManifestBody` to false.
  `--match` prints `scanned`, `filter:` line, `reason` if any, and an
  aligned `# / stableId / sim / name` table with `rationale:` and
  `body:` preview lines per match; `--seed` prints
  `strategy / reason / chosen / bodyPath` metadata plus the seed body
  between `--- BEGIN seedBody --- / --- END seedBody ---` markers
  (truncated at 2000 chars for CLI preview only — the programmatic API
  returns the full body). Registered in `commands.ts`: import adjacent to
  `evolveArena`, export in the `evolveKin` slot after `evolveArena`.
  Validated under `CLAUDE_CONFIG_DIR=/tmp/autoevolve-phase31-validate/home`
  with real manifest + primary body files on disk: **44/44** assertions
  across 14 scenarios A-N: (A) empty stable/ → `matches=[]`, `scanned=0`,
  reason "no stable organisms" + suggestSeedBody strategy='empty' (6);
  (B) seed 3 organisms (review-bot, git-hook-guard, pdf-extractor), review
  proposal → top1=review-bot, similarity > 0 (4); (C) unrelated pdf
  proposal → top1=pdf-extractor (1); (D) top-K ordering strictly descending
  by similarity (3); (E) minSimilarity=0.99 filters everything out, reason
  mentions `minSimilarity` (2); (F) proposal of pure stop-words →
  `matches=[]`, reason="tokenized to empty set" (2); (G) `--no-body`
  vs default both scan 3, both return rationalePreview (2); (H)
  `suggestSeedBody` kin-seeded path: strategy='kin-seeded', seedBody
  starts with `<!-- kin-seeded`, chosenKin=review-bot, body content
  included (5); (I) organism with no primary body → `readPrimaryBody`
  returns null (1); (J) `/evolve-kin --match` command output contains
  title / `scanned: 3` / organism rows (3); (K) `/evolve-kin --seed`
  output contains `strategy: kin-seeded`, BEGIN/END markers, body
  content (4); (L) usage errors: no mode / unknown flag / missing text /
  bad `--top 0` / bad `--min-sim 2` / dual mode conflict (6); (M) CJK
  proposal tokenizes and matches a stable organism with Chinese
  rationale (2); (N) `--top 1` limits to 1 row, `--no-body` reflected in
  filter line (3). Script at `/tmp/autoevolve-phase31-validate/run.ts`
  drives both data APIs and the real command `call()` — no mocks, no
  pre-computed scores, fitness manifests written as plain JSON.
- **DONE (Phase 32, Kinship 自动注入 proposal 管线)**: closes the gap between
  Phase 31's kinshipIndex and the actual emergence pipeline — previously a
  new organism still had to call `/evolve-kin --seed` by hand to benefit from
  its stable kin; now `skillCompiler.compileCandidate` calls
  `findKinStableOrganisms(candidate.name + rationale + winCondition, {topK:1,
  ...})` automatically before rendering the primary body. When a top1 match
  clears the similarity threshold the compiler writes the kin's primary body
  verbatim into `<orgDir>/kin-seed.md` with a multi-line `<!-- kin-seed
  reference (Phase 32) stableId / similarity / seededAt / source -->` audit
  header that explicitly states *"this file is for downstream agents / LLMs
  to consult; it does NOT replace the primary body of this organism."* —
  primary body stays entirely from `renderBodyForKind`, kin-seed.md is a
  **sidecar reference file** (deliberately NOT merged into primary so skill
  loaders don't treat reference content as executable). `kin-seed.md` is
  also NOT in `ALL_PRIMARY_FILENAMES`, so `cleanupStaleBodyFiles` won't
  sweep it during kind-switching compiles. New optional field
  `OrganismManifest.kinSeed?: {stableId, similarity, source, seededAt} | null`
  with three-state semantics: `object` = kin-seed hit, `null` = explicitly
  disabled (env or opts), `undefined` = ran but no match / legacy manifests
  without the field. New `CompileOptions.kinSeed?: boolean` +
  `CompileOptions.kinSeedOptions?: {minSimilarity?, includeManifestBody?}`:
  `opts.kinSeed === true/false` always wins over env; `undefined` defers to
  `CLAUDE_EVOLVE_KIN_SEED` (default **on** — autoinject is the Phase 32
  point; `off|0|false|no` disables). New `CompileResult.kinSeedPath` and
  `CompileResult.kinSeedMatch` expose the sidecar path and the chosen
  `KinshipMatch` for audit/log consumers (`kinSeedMatch` is even returned
  on the `overwrite=false` skip path so reviewers can see the lineage
  without having to re-read manifest). Failure modes are all **silent
  degrade**: empty `stable/`, sub-threshold top match, body-less kin,
  unreadable kin body, un-writable `kin-seed.md` — every branch logs via
  `logForDebugging` and leaves `compileCandidate` returning successfully;
  a kin-seed blow-up must never block a new organism from being born.
  Validated under `CLAUDE_CONFIG_DIR=/tmp/autoevolve-phase32-validate/home`
  with real manifests + body files on disk, real `PatternCandidate` shape:
  **30/30** assertions across 10 scenarios A-J: (A) empty stable/ →
  `compileCandidate` succeeds, `manifest.kinSeed` undefined, no
  `kin-seed.md`, `kinSeedPath` undefined (4); (B) seed `org-review-parent`
  stable, PR-review candidate → `manifest.kinSeed.stableId === 'org-review-parent'`,
  `kin-seed.md` written with `<!-- kin-seed reference` header + original
  body text, `kinSeedMatch` populated, primary body (SKILL.md) still
  the rendered template (not the kin body) (8); (C)
  `CLAUDE_EVOLVE_KIN_SEED=off` → `manifest.kinSeed === null`,
  `kinSeedPath` undefined, no sidecar (3); (D) `opts.kinSeed=true`
  overrides env=off → kin-seed still injected (2); (E)
  `opts.kinSeed=false` → `manifest.kinSeed === null`, `kinSeedPath`
  undefined (2); (F) PDF-subject candidate against PR-review stable →
  sub-threshold, `kinSeed` undefined, no sidecar (2); (G) repeat
  `compileCandidate` same id (default overwrite=true) → `seededAt`
  monotonically increases, sidecar overwritten (3); (H) `overwrite=false`
  with existing manifest → `wasOverwritten=true`, `kinSeedMatch` still
  returned for audit, sidecar `mtime` unchanged (3); (I)
  `kinSeedOptions.minSimilarity=0.99` → threshold filters match, `kinSeed`
  undefined (1); (J) `kinSeedOptions.includeManifestBody=false` manifest-only
  mode — compile doesn't crash, returns healthy manifest (1). Script at
  `/tmp/autoevolve-phase32-validate/run.ts` drives the real
  `compileCandidate` — no mocks, no synthetic kinship scores, real
  PatternCandidate shape, real manifest.json writes.
- **DONE (Phase 33, Arena scheduler 多 worktree 智能调度)**: closes the
  "FIFO worktree spawn" blind spot — Phase 30 gave us batch spawn, but
  order was purely caller-controlled, so `/evolve-arena --spawn a b c d e
  f g h` went FIFO with no notion of *which organism deserves the slot
  most*. New module `services/autoEvolve/arena/arenaScheduler.ts` exports
  three APIs: `scoreShadowPriority(manifest, {maxShadowTrials?}) →
  {priority, components: {trials, stale, age, kin}}` is a pure function
  computing breadth-first priority ∈ [0, 1] with four components each
  clamped to [0, 1] and weighted `trials×0.45 + stale×0.30 + age×0.15 +
  kin×0.10`; `listShadowPriority({excludeActiveWorktree?,
  maxShadowTrials?, topN?}) → PriorityEntry[]` scans shadow/ via
  `listOrganismIds('shadow')` + `readOrganism`, attaches a summary
  (shadowTrials/lastTrialAt/createdAt/kinSeed/name/kind + computed
  ageDays/staleDays) and an `activeWorktree` flag, and sorts descending
  with tie-break on id lexical order so repeated calls return the same
  snapshot (reproducible, audit-friendly); `pickNextShadowIds(count,
  opts?)` is the convenience wrapper that `/evolve-arena --spawn-auto`
  feeds into `spawnOrganismWorktreesBatch`. Weight rationale:
  breadth-first is the main driver (0.45 on trials — we want coverage
  over convergence, so untrailed organisms dominate); stale (0.30)
  prevents starvation of organisms whose last trial was too long ago;
  age (0.15) reflects TTL pressure (shadow organisms expire in 30 days,
  AGE_FULL_DAYS=14 saturates at halfway); kin (0.10) is a deliberately
  small bump — kin-seeded organisms shouldn't dominate just because
  Phase 32 gave them a head start. Component constants exposed in the
  module header (TRIALS_FULL=10, STALE_FULL_DAYS=14, AGE_FULL_DAYS=14)
  are tunable without touching the sort logic. `excludeActiveWorktree`
  defaults to true and uses Phase 30's `listActiveArenaWorktrees` to
  skip ids with an existing `arena/worktrees/<id>/` dir — prevents
  double-spawn attempts; flip false for audit mode to see the *full*
  queue including running ids. `maxShadowTrials` lets callers
  temporarily tighten the breadth-first cap (e.g. 3 instead of 10 to
  force faster rotation). The entire module is **pure-read** (no disk
  writes) and **independent of CLAUDE_EVOLVE_ARENA**, so reviewers can
  always audit. `/evolve-arena` gains two new subcommands (inserted
  after `--list` so the USAGE mode list reads naturally): `--schedule
  [N]` prints an aligned `# / id / prio / trials / ageDays / stale /
  kin / name` table plus a `priority components (weighted sum…)` footer
  — always read-only, works even with CLAUDE_EVOLVE_ARENA=off;
  `--spawn-auto N [--max-parallel M]` runs
  `pickNextShadowIds(N)` → `spawnOrganismWorktreesBatch`, inheriting
  Phase 30's whole-hog cap semantics (hard cap MAX_PARALLEL_ARENAS=8,
  optional `--max-parallel` cap ≤ 64, batch refused if projected
  active > cap). Empty shadow/ gracefully prints `scheduler picked 0
  id(s) for top-N: (none — shadow/ empty or all active)` without
  calling spawn. Mode flags remain mutually exclusive; `--spawn-auto`
  requires a positive integer 1..64, `--schedule` accepts an optional
  1..500. The `evolveArena.description` got bumped to mention both new
  subcommands. Validated under
  `CLAUDE_CONFIG_DIR=/tmp/autoevolve-phase33-validate/home` + a real
  git-init repo with real organism manifests on disk and a real
  `spawnOrganismWorktreesBatch` call creating real git worktrees:
  **34/34** assertions across 10 scenarios A-J: (A) empty shadow/ →
  `listShadowPriority=[]`, `pickNextShadowIds=[]` (2); (B) seed 4
  organisms (fresh/midrun/burnout/aging-kin) with distinct
  trials/stale/age/kinSeed → ranked order `aging-kin > fresh > midrun >
  burnout`, aging-kin priority ≈ 1.0, components/summary fields
  populated on every entry, descending strictly preserved (7); (C) two
  organisms with *identical* createdAt timestamp → tie broken by id
  lexical order (`tie-a < tie-b`), two listShadowPriority calls return
  exactly the same id sequence (3); (D) `maxShadowTrials=3` → an
  organism with trials=5 has trials component zeroed (1); (E)
  `excludeActiveWorktree=true` (default) skips ids with an active
  arena worktree, `false` includes them (2); (F)
  `scoreShadowPriority` pure function — priority and each component
  clamped to [0, 1] (2); (G) `/evolve-arena --schedule` output
  contains title / candidates line / organism rows / kin badge /
  component-weight footer; `--schedule 1` limits to exactly one
  row (6); (H) `/evolve-arena --spawn-auto 2` actually spawns 2 real
  worktrees, top1 aging-kin is among them (5); (I) empty shadow/ with
  `--spawn-auto 3` returns the `(none — shadow/ empty or all active)`
  message without crashing (1); (J) parse errors: missing N,
  `--spawn-auto 0`, dual-mode, `--schedule 0` (4). One test tweaked
  during iteration: the tie-break test initially failed because
  `daysAgoIso(3)` was called at different `Date.now()` between the
  two `seedShadow` calls, so their createdAt differed by a few
  milliseconds, leaving the two organisms *not* actually tied — fixed
  by sharing one `tieCreatedAt` string across both seeds (invariant
  check, not a code fix). Script at
  `/tmp/autoevolve-phase33-validate/run.ts` drives the real data
  APIs + real command `call()` + real git worktree spawn; no mocks,
  no synthetic priorities, no short-circuits.
- **DONE (Phase 34, 血缘链可视化 /evolve-lineage)**: closes the
  "kinSeed is invisible" blind spot — Phase 32 wrote
  `manifest.kinSeed.stableId` onto every new organism, but nothing
  surfaced the resulting ancestry chain to reviewers, so a growing
  genome became opaque. New module
  `services/autoEvolve/arena/lineageBuilder.ts` does one disk scan
  (`listAllOrganisms()`) and builds an in-memory forest:
  `buildLineageForest() → {trees, allNodes, byId, stats}` where each
  `LineageNode` carries `{id, status, name, kind, kinSeed, maturity,
  children, depth, orphanOfId, cycle}`; `summarizeMaturity(manifest)`
  folds `fitness` into `{shadowTrials, wins, losses, neutrals,
  lastTrialAt, winRate, ageDays}` (winRate=null when no samples, so
  the ASCII renderer can print `winRate=—` instead of a misleading
  0.00); tree construction walks `Object.keys(byId).sort()` so the
  output is reproducible across invocations; children per-parent are
  sorted by id lexical order (same Phase 33 tie-break discipline);
  orphans (kinSeed points at an id not in the repo) are collected
  into their own root list with `orphanOfId` set, so audit never
  loses them silently; self-references / back-edges are detected in a
  DFS with a `visiting` Set and marked `cycle=true` without stack
  overflow. `renderLineageAscii(trees, {maxDepth?, showKin?})`
  emits the classic `├─ ` / `└─ ` connectors with `│   ` / 4-space
  continuations, each line formatted `id  [status]  (name)
  winRate=… trials=… age=…d`, child nodes additionally getting
  `[sim=<jaccard> · src=<file>]` unless `--no-kin`, orphans/cycles
  getting `[ORPHAN→<id>]` / `[CYCLE!]` tags; when `maxDepth` clips a
  subtree the renderer prints `…  (N subtree(s) hidden; raise
  --max-depth)` so the collapse is explicit. `summarizeLineage(forest)
  → LineageStats` aggregates `{total, roots, orphans, maxDepth,
  byStatus, kinnedNodes, kinDisabled, largestFamily}` —
  `kinnedNodes` counts organisms whose kinSeed.stableId actually
  resolves (so you can tell "nominal kin" from "real kin"),
  `kinDisabled` surfaces organisms with `kinSeed=null` (Phase 32
  explicitly off), and `largestFamily` picks the root whose subtree
  has the most descendants — useful to spot over-dominant ancestors.
  New command `/evolve-lineage` at `commands/evolve-lineage/index.ts`
  wires three mutually-exclusive modes: `--tree [root-id]
  [--max-depth N] [--no-kin]` prints either the full forest (with a
  one-line `total=… roots=… orphans=… maxDepth=…` header and a
  trailing legend) or a single subtree rooted at `root-id`; `--stats`
  prints the aggregate summary with aligned `by status:` rows and a
  `largest family: <id>  (N nodes in subtree)` tail; `--json
  [root-id]` emits machine-readable JSON — forest form returns
  `{stats, trees[]}`, subtree form returns the single stripped node
  (children nested), in both cases stripping parent-direction refs to
  avoid JSON cycles, preserving `cycle` / `orphanOfId` flags. Parser
  enforces the usual discipline: exactly one mode flag, at most one
  positional root-id (both `--tree --stats` and `id-a id-b` rejected
  early with an explanatory error); `--max-depth` takes an integer
  1..64; unknown flags surface with the full USAGE appended.
  Entirely **pure-read** (no disk writes, no feature-flag gating) so
  it runs even when `CLAUDE_EVOLVE_*` env flags are off — designed
  for safe audit. Registered in `commands.ts` after `evolveKin`.
  Validated under `CLAUDE_CONFIG_DIR=/tmp/autoevolve-phase34-validate/home`
  with real genome manifests on disk: **73/73** assertions across 17
  scenarios A-Q: (A) empty genome → `--tree` returns graceful
  `(no organisms ...)` (1); (B) single stable root → forest has 1
  tree with correct id/roots/total/maxDepth, byStatus.stable=1,
  winRate=0.80 from wins=4/losses=1 (7); (C) two-generation chain
  stable→shadow → single tree with 1 child at depth=1, maxDepth=1,
  rendered output contains `└─` connector and `sim=` / `src=SKILL.md`
  tags (9); (D) three-generation chain stable→stable→shadow → tree
  has 3 nodes with total=3, maxDepth=2, grandchild at depth=2 (7);
  (E) orphan (kinSeed→nonexistent id) → stats.orphans=1, node has
  `orphanOfId` set, rendered output contains `ORPHAN→<id>` tag (3);
  (F) `kinSeed=null` (explicit off) → treated as root,
  stats.kinDisabled=1, stats.roots=1 (2); (G) cycle (kinSeed points at
  self) → node marked `cycle=true`, build doesn't stack-overflow (2);
  (H) three siblings under one parent → children array is
  `[aaa, mmm, zzz]` lexically sorted, reproducible across two calls
  (2); (I) `--tree <root-id>` subtree filter → output contains
  "subtree rooted at:" header + the subtree + not the other root (3);
  (J) `--tree --max-depth 1` on a three-generation chain → output
  contains `subtree(s) hidden` and omits the grandchild (2); (K)
  `--tree --no-kin` → non-legend body has no `sim=` / `src=`, child
  node still rendered (3); (L) `--stats` output contains total /
  roots / orphans / largest family / by status / specific archived
  count (7); (M) `--json` returns valid JSON with `stats` + `trees[]`,
  parent's children count matches seeded data (4); (N) `--json
  <root-id>` returns single stripped subtree (no `trees` field) with
  correct id and recursive children (4); (O) parse errors: dual-mode,
  double root-id, unknown flag, `--max-depth` missing value,
  `--max-depth 0`, missing mode, `--json` with unknown id (7); (P)
  winRate computes to 0.60 for wins=3/losses=2, `null` for no samples,
  renderer prints `winRate=—` for the null case (3); (Q) depth
  recursion assigns 0/1/2/3 correctly down a four-generation chain,
  stats.maxDepth=3 (5). One test tweaked during iteration: K1
  initially flagged false positive because the trailing `legend:` line
  in `--tree` output contains the documentation string
  `sim=<jaccard> src=<file>` describing *what* the tags mean — fixed
  by filtering out the legend line before the `!includes('sim=')`
  assertion (invariant check, not a code fix — legend is correctly
  present so audiences can decode the child-tag syntax). Script at
  `/tmp/autoevolve-phase34-validate/run.ts` drives the real data APIs
  + real command `call()`; no mocks, no synthetic manifests, no
  mocked fs. Map row for `/evolve-lineage` added below the
  `/evolve-kin` row.
- **DONE (Phase 35, 冷启动 warmstart 策略库)**: closes the
  "new repo → empty shadow/ → arena idles forever" cold-start gap —
  Phase 2's pattern miner only produces shadow candidates after enough
  feedback memories / dreams accumulate, so a freshly initialized
  genome could stay empty for days while Phase 33's scheduler spun on
  nothing and Phase 32's kin-seed could never match. New module
  `services/autoEvolve/emergence/warmstartLibrary.ts` ships an
  in-code curated catalog of 7 baseline patterns (review-guard,
  safe-rm-guard, commit-msg-guard, test-flaky-retry, memory-audit,
  verify-before-claim, skillify-reminder) — each is a full
  `BaselineTemplate {slug, pitch, kind, pattern, nameSuggestion,
  rationale, winCondition, tags[]}` that `baselineToPatternCandidate`
  lifts into a real `PatternCandidate` (with `id=pat-warm-<slug>`,
  `evidence.sourceFeedbackMemories=['warmstart:<slug>']`,
  `coveredByExistingGenome=false`) and feeds into the Phase 2
  `compileCandidate(...)` pipeline so every seeded organism is
  structurally indistinguishable from miner-born shadow organisms
  (status=shadow, fitness zeroed, can be kin-seeded, can be
  promoted); this preserves Phase 7's invariant that every organism
  flows through the same manifest contract. `seedWarmstart({include,
  exclude, dryRun, force}) → WarmstartSeedResult` walks the catalog
  once, producing four outcome classes per baseline: `seeded` (fresh
  compile), `skipped` (shadow already exists, no --force),
  `planned` (dry-run), `filtered` (fell outside include or hit
  exclude); include **and** exclude compose — when both are present
  include chooses the candidate set and exclude further trims inside
  it (tested in scenario H). `organismIdOf(b)` recomputes the same
  `sha256(${nameSuggestion}:v1)[0..8]` → `orgm-<hex>` hash that
  `skillCompiler.makeOrganismId` uses, so the dedup `existsSync`
  check on `getOrganismDir('shadow', id)` lines up with the dir
  compileCandidate actually writes — the alternative (`org-warm-<slug>`
  guess) would have silently double-seeded. `listBaselines()` returns
  defensive copies (each `tags` is cloned) so external callers cannot
  mutate the catalog across calls — validated by mutating a returned
  entry's tags and confirming the next `listBaselines()` is clean.
  `isWarmstartWriteEnabled()` applies a three-tier env precedence:
  explicit `CLAUDE_EVOLVE_WARMSTART=on|off` wins; falls back to
  `CLAUDE_EVOLVE=off` (safety override, keeps whole kernel cold);
  otherwise default on, because warmstart's writes are scoped to
  `shadow/` only and the stronger `--dry-run` still audits without
  gate. New command `/evolve-warmstart` at
  `commands/evolve-warmstart/index.ts` wires two mutually-exclusive
  modes: `--list [--tags tag1,tag2]` (always read-only, always
  available) prints an aligned `slug / kind / tags / pitch` table
  with a total-count header and a `hint: ... --seed` trailer,
  `--tags` filters to baselines whose tags include any listed value;
  `--seed [--include ...] [--exclude ...] [--dry-run] [--force]`
  synthesizes into shadow/ via `seedWarmstart`, printing per-entry
  rows tagged `✓ seeded` / `✎ planned` / `· skipped` / `— filtered`
  plus header counts and a "next: `/evolve-status` / `/evolve-lineage`"
  hint when any organisms were actually written. Parser enforces the
  usual discipline: exactly one mode flag, csv-value flags reject
  empty lists, unknown flags surface with USAGE appended; the
  `--dry-run` path is treated as pure-read and **bypasses** the
  `isWarmstartWriteEnabled` gate so operators can always preview a
  plan even with evolution fully gated off (essential for onboarding
  a locked-down repo). Registered in `commands.ts` right after
  `evolveLineage`. Validated under
  `CLAUDE_CONFIG_DIR=/tmp/autoevolve-phase35-validate/home` with real
  genome writes: **96/96** assertions across 17 scenarios A-Q:
  (A) listBaselines returns 7 entries with all required fields +
  returned array is a defensive copy (mutation doesn't leak) (3);
  (B) findBaseline exact hit + unknown slug → undefined (3);
  (C) default seed plants all 7, organism id matches the
  sha256(nameSuggestion:v1)[0..8] algorithm for each of the 7, and
  `manifest.json` exists on disk with status=shadow and name aligned
  per baseline (26); (D) re-seed without --force → 7 skipped and the
  on-disk manifest mtime is unchanged (3); (E) --force re-compiles
  all 7 and refreshes mtime (3); (F) include=['review-guard'] → 1
  seeded, 6 filtered, correct slug picked (3); (G) exclude=
  ['safe-rm-guard'] → 6 seeded, 1 filtered, correct slug dropped (3);
  (H) include+exclude composed → only review-guard seeded (exclude
  continues trimming within include's set) (1); (I) dry-run → 0
  written to disk, 7 planned, attempted=false, dryRun=true, no
  manifest file for any organism (4); (J) isWarmstartWriteEnabled
  precedence — default on, WARMSTART=off → false, WARMSTART=on →
  true, EVOLVE=off fallback → false, WARMSTART=on overrides
  EVOLVE=off (5); (K) `/evolve-warmstart --list` output contains
  title, 2 specific slugs, total count, hint, and --tags filter
  narrows to safety-tagged entries (6); (L) `--seed` default-gate-on
  output has attempted: true + seeded=7 + badge + next: hint (4);
  (M) `--seed --dry-run` output has dryRun: true + planned=7 +
  badge, and shadow/ dir is empty (4); (N) `--seed` with
  WARMSTART=off reports attempted:false and gate hint, flipping to
  on restores writes (3); (O) parse errors: dual-mode, unknown flag,
  empty --include, empty --tags, no mode (5); (P) Phase 34
  lineageBuilder recognizes the 7 warmstart organisms —
  stats.byStatus.shadow=7, stats.total=7 (so warmstart cleanly
  integrates with the visualizer) (2); (Q) every baseline's
  winCondition is a concrete measurable statement >20 chars long,
  satisfying the very rule `commit-msg-guard` / `verify-before-claim`
  advocate — the library eats its own dogfood (7). One test
  adjustment during iteration: initial organism id prediction used
  `org-warm-<slug>`, which would have let `existsSync` miss the real
  `orgm-<hex>` path that skillCompiler writes — fixed inside the
  module by adding a local `organismIdOf(b)` that re-derives the same
  `sha256(${nameSuggestion}:v1)[0..8]` hash used by
  `skillCompiler.makeOrganismId` (code fix, not a test fix). Script
  at `/tmp/autoevolve-phase35-validate/run.ts` drives real
  compileCandidate + real disk + real command `call()`; no mocks,
  no synthetic shadow fixtures. Map row for `/evolve-warmstart`
  added below the `/evolve-lineage` row.
- **DONE (Phase 36, Phase 24+27 联合调优协调器)**: closes the
  "two tuners race to the same fitness signal" gap — Phase 24's
  `thresholdTuner` and Phase 27's `metaEvolver` both read the same
  `fitness.ndjson` and can both apply their suggestions in the same
  minute, producing a window where thresholds AND weights have both
  moved at once and the next window's delta is impossible to
  attribute. Worse, `computeWeightSuggestion` internally calls
  `loadTunedThresholds()` to bucket observations into win/loss by
  Phase 24's current thresholds — so the moment the user runs
  `/evolve-tune --apply`, every subsequent `/evolve-meta` suggestion
  is being computed against a different SNR substrate, and the two
  changes compound non-linearly. New module
  `services/autoEvolve/oracle/jointTuningCoordinator.ts` exposes
  `planJointTuning(windowDays?) → JointTuningPlan` that calls both
  `computeTuningSuggestion` and `computeWeightSuggestion` in one shot
  and classifies the joint outcome via two-tier thresholds:
  `THRESHOLD_MIN_EFFECTIVE_DELTA=0.01` / `WEIGHT_MIN_EFFECTIVE_DELTA=0.02`
  demote noise rows to "not ready" (insufficient samples OR every row
  |delta| below this bar); `THRESHOLD_BIG_SINGLE=0.1` / `_BIG_NORM=0.15`
  and `WEIGHT_BIG_SINGLE=0.05` / `_BIG_NORM=0.08` flag a side as
  "big". Five `InteractionKind` buckets — `both-insufficient`
  (quiet), `threshold-only` (Phase 27 has no signal), `weights-only`
  (Phase 24 has no signal), `cooperative` (both small, safe to apply
  together), `big-shake` (both ready AND at least one side big —
  needs damping) — each maps to an `ApplyStrategy`: `nothing` /
  `thresholds-only` / `weights-only` / `thresholds-then-weights` /
  `thresholds-then-weights-damped`. The **apply order is always
  thresholds first, then weights** — because Phase 27 depends on
  Phase 24 values, writing thresholds first means the subsequent
  weight recompute is against the new bucketing; the reverse order
  would leave stale weight suggestions. `applyJointTuningPlan(plan)`
  implements this: after `saveTunedThresholds(...)` it re-calls
  `computeWeightSuggestion(windowDays)` so Phase 27's SNR sees the
  freshly applied thresholds, then either writes the recomputed
  suggestion directly (cooperative) or damps it via `dampFactor=0.5`
  (big-shake) — damping takes `current + 0.5*(suggested-current)`
  per dim, clamps to `[WEIGHT_MIN, WEIGHT_MAX]=[0.05, 0.7]`, then
  re-normalizes to sum=1 and stamps version=1 + updatedAt. If the
  recomputed suggestion becomes insufficient (e.g., new tighter
  thresholds drop win+loss samples below `MIN_SAMPLES_FOR_META=20`),
  `actualStrategy` gracefully **falls back to thresholds-only** —
  the joint coordinator never forces a bad weight update. Return
  value preserves a per-dim `{raw, damped}` audit trace so operators
  can always see how much each weight moved relative to the
  undamped target. `isJointTuneWriteEnabled()` uses a three-tier env
  precedence: `CLAUDE_EVOLVE_JOINT` explicit on/off wins; then both
  `CLAUDE_EVOLVE_TUNE=on` AND `CLAUDE_EVOLVE_META=on` (both
  individual gates must be lit to avoid sneaking a joint write past
  either side's refusal); then `CLAUDE_EVOLVE=on` as catch-all;
  default **off** — joint writes have a bigger blast radius than
  either tuner alone, so the conservative default mirrors `/evolve-tick`
  rather than `/evolve-warmstart`. New command `/evolve-tune-joint`
  at `commands/evolve-tune-joint/index.ts` offers dry-run (default)
  + `--apply` + `--reset --confirm`, all with `--window N` (1-3650).
  Dry-run output renders two aligned tables — thresholds (name /
  current / suggested / delta / rationale) and weights (same plus
  SNR column) — then a `plan notes` section with the
  classification rationale; always read-only, never gated. `--apply`
  runs the gate check then calls `applyJointTuningPlan`, appending
  an "apply result" block with `actualStrategy` + per-dim raw→damped
  trace when damping kicked in. `--reset --confirm` deletes both
  `tuned-thresholds.json` and `tuned-oracle-weights.json` (requires
  `--confirm` **and** env gate) to restore DEFAULT_TUNED_THRESHOLDS
  + DEFAULT_TUNED_ORACLE_WEIGHTS. Parse guards catch `--apply
  --reset` (mutually exclusive), unknown flags, `--window` with no
  value, and non-integer / out-of-range windows. Registered in
  `commands.ts` right after `evolveWarmstart`. Validated under
  `CLAUDE_CONFIG_DIR=/tmp/autoevolve-phase36-validate/home` with
  real fitness ledger writes (no mocks, no mocked tuners): **87/87**
  assertions across 18 scenarios A-R: (A) module exports
  planJointTuning / applyJointTuningPlan / isJointTuneWriteEnabled +
  constants (5); (B) empty ledger → both-insufficient / nothing (5);
  (C) 8 samples (below Phase 24 min=10) → both-insufficient (4);
  (D) 12 wide-spread samples → threshold-only / thresholds-only
  (weights still below Phase 27 min=20) (5); (E) 30 calibrated
  samples with current-weights pre-aligned to the SNR=0 fallback
  (0.25 each) so weight delta stays within cooperative band →
  non-shake strategy + dampFactor=1.0 (6); (F) 30 samples with
  both sides big → big-shake / thresholds-then-weights-damped /
  dampFactor=0.5 (6); (G) apply(nothing) leaves both tuned files
  non-existent (5); (H) apply(thresholds-only) writes only thresholds
  (6); (I) apply(big-shake) writes both, damped trace non-empty,
  every dim present, at least one dim damped != raw (5); (J) damped
  dims in [0.05, 0.7], sum ≈ 1, disk values match trace (9);
  (K) fallback path under tight thresholds (17 wins + 3 losses)
  — strategy returned must be one of 5 legal kinds, apply doesn't
  throw (2); (L) env gate precedence — default off, JOINT=on on,
  JOINT=off overrides TUNE+META=on, TUNE+META=on standalone,
  TUNE=off alone falls, EVOLVE=on fallback (6); (M) dry-run output
  contains title + interaction + strategy + thresholds block +
  weights block + plan notes + hint (7); (N) --apply with gate off
  → attempted: false + gate message (2); (O) --apply with
  JOINT=on writes thresholds + prints apply result + actualStrategy
  (3); (P) --reset --confirm under gate removes both files (3);
  (Q) --reset without --confirm refuses (1); (R) parse errors
  combos (4). One test iteration during fixture tuning:
  scenario E originally paired dim variance (wins=0.55/losses=0.45
  userSatisfaction) with the default weights (0.4/0.3/0.15/0.1),
  producing weight delta=0.15 that crossed into big-shake — the
  cooperative-band expectation was the test bug, not the classifier;
  fixed by pre-writing tuned-oracle-weights.json=0.25/0.25/0.25/0.25
  (what SNR=0 on uniform dims would converge to) so the delta
  collapses and the cooperative path is actually exercised. Script
  at `/tmp/autoevolve-phase36-validate/run.ts` drives real
  fitness.ndjson + real saveTunedThresholds + real
  saveTunedOracleWeights + real command `call()`.
- **DONE (Phase 37, Promotion tier 阈值自调)**: closes the
  auto-promotion-thresholds half of the "Threshold auto-tuning (Phase 14
  candidate)" roadmap item —— autoPromotionEngine 的 4 个 tier 常量
  (`SHADOW_TO_CANARY_MIN_INVOCATIONS=3` / `SHADOW_TO_CANARY_MIN_AGE_DAYS=1` /
  `CANARY_TO_STABLE_MIN_INVOCATIONS=10` / `CANARY_TO_STABLE_MIN_AGE_DAYS=3`)
  不再纯硬编码。新模块
  `services/autoEvolve/emergence/promotionThresholdTuner.ts` 抽出
  `TunedPromotionThresholds { version:1, updatedAt, shadowToCanaryMinInvocations,
  shadowToCanaryMinAgeDays, canaryToStableMinInvocations, canaryToStableMinAgeDays }`,
  落盘 `oracle/tuned-promotion-thresholds.json`(新 path helper
  `getTunedPromotionThresholdsPath` 位于 `services/autoEvolve/paths.ts`),
  `DEFAULT_TUNED_PROMOTION_THRESHOLDS` 与原硬编码完全相等,文件缺失即行为
  不变,完全向后兼容。`autoPromotionEngine.decide` 在 Phase 7 favorable
  加速判定后插入 `const tuned = loadTunedPromotionThresholds()`,用
  `tuned.*` 替换 shadow→canary / canary→stable 两个分支里对原硬编码的
  4 处引用(原 `export const` 保留供外部 import)。**信号来源**:tuner
  读 `oracle/promotions.ndjson` 的 Transition 流,按 `(from,to)` 分桶
  `shadow→canary` 和 `canary→stable`,窗口内 promotion 事件的
  organism 集合为分母,其中又在窗口后出现 `to='vetoed'`(必须
  `transition.at >= promotedAt`,ordering guard)的 organism 为分子
  —— `regressionRate_tier`。只数 `vetoed` 不数 `archived`,因为
  archived 两义(stable 正常退役 vs shadow/canary auto-age 超时),会
  污染"真坏"信号。**决策规则**:
  `decideRow(name, current, regressionRate, total, field)` 输出 `{name,
  current, suggested, rationale}`,`regressionRate ≥ HIGH_REGRESSION_RATE=0.3`
  → tighten +1;`≤ LOW_REGRESSION_RATE=0.05` AND `total ≥ MIN_SAMPLES_RELAX=5`
  → relax -1;其它 hold。所有 suggested 被夹紧在
  `[INVOCATIONS_MIN=1, INVOCATIONS_MAX=50]` / `[AGE_DAYS_MIN=0, AGE_DAYS_MAX=30]`;
  全局样本门槛 `MIN_SAMPLES_FOR_PROMO_TUNE=5`(总晋升<5 直接 insufficient,
  `rows=[]`)。`computePromotionTuningSuggestion(windowDays=30) →
  PromotionTuningSuggestion { windowDays, totalTransitions,
  shadowToCanaryCount/Regressed, canaryToStableCount/Regressed,
  insufficientReason, rows[] }`;`suggestionToNext(s)` 保留未在 rows
  出现的 tier-field(只有某 tier 有数据时另一 tier 原值不动);
  `loadTunedPromotionThresholds()` mtime 缓存 + 防御性 schema 校验,
  坏文件→fallback 到 DEFAULT 不覆盖原文件;`saveTunedPromotionThresholds(t)`
  写后立即清缓存;`_resetTunedPromotionThresholdsCacheForTest()` 给验证用。
  新命令 `/evolve-tune-promotion` 位于
  `commands/evolve-tune-promotion/index.ts`,hidden,解析
  `[--apply|-a] [--window|-w DAYS] [--reset]`(integer 1..365,默认 30),
  `--apply`/`--reset` 互斥,三种模式:dry-run 打印 `## autoEvolve Promotion
  Threshold Auto-Tuner (Phase 37)` + `mode/window/total transitions` 头部
  + 两行 `shadow→canary: promoted=X regressed(vetoed)=Y rate=Z.ZZZ` /
  `canary→stable: ...` + 对齐 Suggestion 表 + Rationale 区块 + 尾部 hint;
  `--apply` insufficient 时跳过不覆盖现有文件,否则写盘 + `Apply result:`
  区块列 path / updatedAt / new values / mtime cache 提示;`--reset`
  `unlinkSync` + 清缓存 + `removed <path>` + `fall back to DEFAULT` 提示,
  文件不存在时 `nothing to reset`;write/unlink 失败都捕获打印。
  **不设 env gate** —— tuner 只写 `oracle/tuned-promotion-thresholds.json`
  一个文件,blast radius 仅限自家 tier 阈值,不需要 /evolve-tune-joint
  那种跨模块级 gate;保守 ±1 步长 + 夹紧 + insufficient 自守本身就是
  闸门。Validated **97/97** across 21 scenarios A-U: (A, 15 checks) module
  shape + DEFAULT ≡ autoPromotionEngine 原硬编码 + 常量导出
  (HIGH/LOW rate, MIN_SAMPLES, MIN/MAX 夹紧);(B, 2) load fallback 默认
  不创建文件;(C, 5) save + roundtrip 5 字段;(D, 2) mtime 缓存失效;
  (E, 5) 空 ledger insufficient + 计数全 0;(F, 4) 3<5 promotions →
  insufficient + 仍正确分桶计数;(G, 7) shadow→canary 5/3=0.6 → tighten
  +1/+1 + rationale 含 `tighten`;(H, 5) shadow→canary 10/0=0 → relax
  -1/-1 + rationale 含 `relax`(baseline 先调到 5/3 留出 relax 空间);
  (I, 5) canary→stable 5/3=0.6 → tighten;(J, 3) canary→stable 10/0=0 →
  relax;(K, 3) 10/1=0.1 in [0.05,0.3) → hold + rationale 含 `hold`;
  (L, 2) shadowInv/Age 已在 MAX 时 tighten 被夹紧;(M, 2) shadowInv/Age
  已在 MIN 时 relax 被夹紧;(N, 2) vetoed-before-promoted 不计为回归
  (ordering guard,`transition.at >= promotedAt` 生效);(O, 4)
  suggestionToNext 只更新有 rows 的 tier,另一 tier 原值保留
  + version=1 + updatedAt 刷新;(P, 8) 命令 dry-run 输出结构(Phase 37
  标题、dry-run 标签、window 行、shadow→canary/canary→stable 行、
  --apply 提示、无写盘消息、文件未创建);(Q, 6) 命令 --apply 写盘并
  shadowInv tightened 3→4 / shadowAge 1→2 + file schema v1;(R, 5)
  --reset 删除已有文件 + 二次 --reset `nothing to reset`;(S, 5) parse
  guards(--apply+--reset 互斥 / --window 缺值 / --window 非数字 /
  未知 flag / --help 打印 Usage);(T, 2) --window 7 天只看到 3 仍
  insufficient,--window 120 天看到全部 8;(U, 4) autoPromotionEngine
  通过 tuner 读到非默认值 99/99,删除 tuned 文件后回归 DEFAULT 3/10。
  Fixture under `/tmp/autoevolve-phase37-validate/home` with real
  `appendTransition()` writing signed NDJSON lines to real
  `promotions.ndjson`;no mocks;script at
  `/tmp/autoevolve-phase37-validate/run.ts` drives real
  `saveTunedPromotionThresholds` + real `computePromotionTuningSuggestion`
  + real command `call()` invocations.
- **DONE (Phase 38, Archive 阈值自调)**: closes the remaining half of the
  "Threshold auto-tuning (Phase 14 candidate)" roadmap item —— autoArchiveEngine
  的 2 个 stable-unused 常量(`STALE_STABLE_UNUSED_DAYS=45` /
  `STALE_STABLE_MIN_AGE_DAYS=14`)不再纯硬编码。新模块
  `services/autoEvolve/emergence/archiveThresholdTuner.ts` 抽出
  `TunedArchiveThresholds { version:1, updatedAt, staleStableUnusedDays,
  staleStableMinAgeDays }`,落盘 `oracle/tuned-archive-thresholds.json`
  (新 path helper `getTunedArchiveThresholdsPath` 位于
  `services/autoEvolve/paths.ts`),`DEFAULT_TUNED_ARCHIVE_THRESHOLDS` 与
  原硬编码完全相等(45/14),文件缺失即行为不变,完全向后兼容。
  `autoArchiveEngine.decideByStale`(Phase 38 后改为 `export function`
  以便验证层直接测试)在 age/dsli 算出后立刻 `const tuned =
  loadTunedArchiveThresholds()`,用 `tuned.staleStableMinAgeDays` /
  `tuned.staleStableUnusedDays` 替换原硬编码,同时 `archive` rationale
  里的 `threshold=Xd` 也随 tuned 值更新 —— 下一轮 tuner 读的就是新值
  生成的样本,形成 **self-calibrating 闭环**。原
  `export const STALE_STABLE_UNUSED_DAYS/MIN_AGE_DAYS` 继续导出(外部
  import / 向后兼容)。**信号源(Phase 38 创新点)**:
  `promotionFsm.ts` 将 `archived` 设为终态(`archived → ∅`),FSM 不允许
  复活,所以 "archived→resurrected" 类信号恒为 0。转而解析 autoArchiveEngine
  已经写进 Transition.rationale 的 dsli —— 格式
  `"auto-stale: no invocation for {dsli}d (lastInvokedAt=..., threshold=Xd,
  age=Yd)"`,`parseDsliFromRationale(s)` 用 `/no invocation for (\d+\.?\d*)d/`
  抽数,失败返回 null(跳过这条,不污染统计)。**分桶**:窗口内所有
  `trigger='auto-stale'` 事件的 dsli 按 `current.staleStableUnusedDays`
  分三桶 —— `borderline = 0 < dsli ≤ threshold * (1+BORDERLINE_MARGIN=0.2)`
  (刚过线,阈值偏紧);`longAbandoned = dsli ≥ threshold *
  LONG_ABANDON_MARGIN=2.0`(早已躺尸,阈值偏松);中间 healthy。
  **决策**:`borderlineRate ≥ HIGH_BORDERLINE_RATE=0.4` → relax
  (UNUSED +`UNUSED_STEP=5`, MIN_AGE +`MIN_AGE_STEP=2`);
  `longAbandonedRate ≥ HIGH_ABANDONED_RATE=0.6` → tighten(-5/-2);其它
  hold。步长比 Phase 37 的 ±1 大,因为 45d 的 ±1 < 噪声,±5/±2 保证可见。
  全部 clamp 到 `[UNUSED_DAYS_MIN=7, UNUSED_DAYS_MAX=365]` /
  `[MIN_AGE_DAYS_MIN=1, MIN_AGE_DAYS_MAX=90]`,避免一次跑到极端。
  **insufficient 门槛**:`parsedCount < MIN_SAMPLES_ARCHIVE_TUNE=5` 直接
  `rows=[]` + reason,防止早期噪声。**API**:`loadTunedArchiveThresholds()`
  mtime 缓存(autoArchiveEngine 热路径调用)+ 防御性 schema 校验,
  坏文件 fallback DEFAULT 不覆盖;`saveTunedArchiveThresholds(t)` 写后立即
  清缓存;`computeArchiveTuningSuggestion(windowDays=30) →
  ArchiveTuningSuggestion { windowDays, totalTransitions, autoStaleCount,
  parsedCount, borderlineCount, longAbandonedCount, insufficientReason, rows[] }`;
  `suggestionToNext(s)` 保留未出现在 rows 的字段(不破坏其它维度);
  `_resetTunedArchiveThresholdsCacheForTest()` 给验证用。新命令
  `/evolve-tune-archive` 位于 `commands/evolve-tune-archive/index.ts`,
  hidden,参数口径与 `/evolve-tune-promotion` 同构
  `[--apply|-a] [--window|-w DAYS] [--reset]`(integer 1..365,默认 30;
  `--apply`/`--reset` 互斥)。Dry-run 打印 `## autoEvolve Archive
  Threshold Auto-Tuner (Phase 38)` + mode/window/total 头部 + `auto-stale
  events (in window): N  dsli-parsed: M` + borderline/longAbandoned rate
  (parsedCount>0 时)+ Suggestion 对齐表 + Rationale 区块 + 尾部
  `--apply`/`--reset` 提示;`--apply` insufficient 时跳过(不覆盖现有
  tuned 文件),就绪则写盘 + `Apply result:` 区块列 path / updatedAt /
  new values / mtime cache 提示;`--reset` `unlinkSync` + 清缓存 +
  `removed <path>` + `fall back to DEFAULT` 提示,文件不存在时 `nothing
  to reset`;write/unlink 失败捕获打印。**不设 env gate** —— tuner 只
  写 `oracle/tuned-archive-thresholds.json` 一个文件,blast radius 仅限
  archive 阈值,保守步长 + 夹紧 + insufficient 自守就是闸门。
  Validated **104/104** across 22 scenarios A-V:(A, 16) module shape +
  DEFAULT ≡ autoArchiveEngine 原硬编码 + 所有常量导出(UNUSED_MIN/MAX=7/365,
  MIN_AGE_MIN/MAX=1/90, UNUSED_STEP=5, MIN_AGE_STEP=2, BORDERLINE_MARGIN=0.2,
  LONG_ABANDON_MARGIN=2.0, HIGH_BORDERLINE_RATE=0.4, HIGH_ABANDONED_RATE=0.6,
  MIN_SAMPLES=5);(B, 2) load fallback 不创建文件;(C, 5) save+roundtrip
  + file schema v1 + updatedAt 回填;(D, 2) mtime 缓存失效(first=50,
  after newer write=70);(E, 5) parseDsliFromRationale 解 47.3/100/0.5
  + 非匹配/空 → null;(F, 4) 空 ledger insufficient + 计数全 0;
  (G, 3) 4<5 auto-stale → insufficient;(H, 7) 5 borderline(dsli 46..50,
  threshold=45)→ relax,unused 45→50(+5),minAge 14→16(+2),rationale
  含 `relax`;(I, 7) 5 longAbandoned(dsli 90..130)→ tighten,unused
  45→40(-5),minAge 14→12(-2),rationale 含 `tighten`;(J, 6) 5 healthy
  dsli(60,65,70,75,80,healthy 区间 (54,90))→ hold 两字段 + rationale
  含 `hold`;(K, 2) unused 已在 363 时 +5 clamp 至 365 / minAge 已在 89
  时 +2 clamp 至 90;(L, 2) unused 已在 10 时 -5 clamp 至 UNUSED_DAYS_MIN=7
  / minAge 已在 2 时 -2 clamp 至 MIN_AGE_DAYS_MIN=1;(M, 4) 窗口过滤
  —— 3 近期 + 3 过期(-40d)事件,window=30 只看到 3(insufficient),
  window=60 看到全部 6(ready);(N, 3) 混合 trigger —— 5 auto-stale +
  3 auto-age + 3 auto-oracle veto,totalTransitions=11 但
  autoStaleCount=5/parsedCount=5;(O, 3) rationale 不可解析的 auto-stale
  被跳过,autoStaleCount=5 但 parsedCount=3,3<5 → insufficient;
  (P, 4) suggestionToNext 只更新 staleStableUnusedDays row 时
  staleStableMinAgeDays 保留原值 + version=1 + updatedAt 刷新;
  (Q, 9) 命令 dry-run 输出(Phase 38 标题、dry-run 标签、auto-stale
  events 行、Suggestion/Rationale 块、--apply 提示、无写盘副作用);
  (R, 5) 命令 --apply 写盘 + unused/minAge 正确 tighten 40/12 + APPLY
  标签;(S, 3) --reset 删除已有文件 + 二次 --reset `nothing to reset`;
  (T, 5) parse guards(--apply+--reset 互斥 / --window 缺值 / --window
  非数字 / 未知 flag / --help 打印 Usage);(U, 4) --apply 在
  insufficient 时跳过 + 不覆盖用户手改文件(unused=123/minAge=45 保持);
  (V, 3) autoArchiveEngine.decideByStale 通过 tuner 读到非默认值:
  tuned 300/90 下 dsli=100 age=60 → skip too_young;删除 tuned 后
  回归 DEFAULT → archive;再写 tuned 200/14 → skip recently_invoked
  —— 证明 mtime 缓存下 engine 与 tuner 实时同步。Fixture under
  `/tmp/autoevolve-phase38-validate/home` with real `appendFileSync`
  writing signed-stub NDJSON to real `promotions.ndjson`;no mocks;
  script at `/tmp/autoevolve-phase38-validate/run.ts` drives real
  `saveTunedArchiveThresholds` + real `computeArchiveTuningSuggestion`
  + real command `call()` + real `engine.decideByStale(manifest)`
  invocations.
- **DONE (Phase 39, Oracle 权重时间衰减)**: 解决 `oracleAggregator.aggregate*`
  的"老样本和新样本同权"痛点 —— stable organism 一旦积累了早期高分会被
  历史均值锁死(最近 20 条全 loss 也拉不动 +0.3 的 avg),反向也成立(一条
  早年 loss 样本持续压制"刚刚起色"的 shadow)。Phase 39 在 aggregator 的
  sum 阶段接入 **指数半衰期衰减**:`weight(score) = 0.5^((now-scoredAt)/halfLifeDays)`,
  `weightedAvg = Σ(score·weight) / Σ(weight)`。新模块
  `services/autoEvolve/oracle/oracleDecayTuner.ts` 抽出
  `TunedOracleDecay { version:1, updatedAt, halfLifeDays }`,落盘
  `oracle/tuned-oracle-decay.json`(新 path helper `getTunedOracleDecayPath`
  位于 `services/autoEvolve/paths.ts`)。**向后兼容关键点(与 Phase 24/37/38
  的设计哲学不同)**:Phase 24/37/38 的 DEFAULT 直接等于原硬编码生效值,
  文件缺失即等价于老行为;但 oracleAggregator 原本根本没有"halfLife"
  这个概念,没有"原值"可对齐。Phase 39 引入 **sentinel**:
  `DEFAULT_TUNED_ORACLE_DECAY.halfLifeDays = 0` 意味着 "衰减关闭,
  `decayWeight ≡ 1`,aggregator 退化为算术平均"。`decayWeight` 内部
  `if (!(halfLifeDays > 0)) return 1`,这条语义保证"文件缺失 / 非法
  schema / 用户主动 --disable"三种情况下 aggregator 100% 等同 Phase 1-38,
  零行为变更。用户 opt-in 的唯一入口是 `/evolve-tune-oracle-decay --apply`
  写入正值。**信号源**:`recentFitnessScores(windowSamples)` 读
  `fitness.ndjson`,对每条算 `age = (now - scoredAt)/86400_000`(跳过
  非法 ISO 和未来时间),取 **p75 age**(75 分位,nearest-rank)作为
  "有意义样本寿命"。**决策**:`current=0`(sentinel)时走 first-opt-in
  —— `p75Age ≥ MIN_P75_AGE_FOR_FIRST_OPT_IN=14d` → `suggested =
  round_to_step(p75)`(HALF_LIFE_STEP=15 对齐);`p75<14d` 则 hold
  并打印 `samples too fresh`(样本还太新,没必要启用衰减)。`current>0`
  时按 `ratio = p75/halfLife` 决策:`ratio ≥ HIGH_RATIO=2.0` → relax
  `+HALF_LIFE_STEP=15`(半衰期太短,老样本过快消失);`ratio ≤
  LOW_RATIO=0.3` → tighten `-15`(半衰期太长,老样本几乎不衰减);
  中间 hold。全部 clamp 到 `[HALF_LIFE_MIN=7, HALF_LIFE_MAX=365]`。
  步长 15 比 Phase 37 的 ±1 大,因为 halfLife 量级本身大,±1 小于噪声
  观察不到效果。全局样本门槛 `MIN_SAMPLES_DECAY_TUNE=10`,`<10` 直接
  insufficient。**decayWeight 防守语义**:`halfLifeDays ≤ 0 → 1`(sentinel
  或非法)、`Date.parse 失败 → 1`(坏 ISO 不强行衰减)、`age ≤ 0 → 1`
  (未来时间戳保守处理)。这是 aggregator 热路径,必须无异常。**API**:
  `loadTunedOracleDecay()` 带 mtime 缓存(两个 aggregate 函数每次调用都读),
  schema 校验 `version!==1 || halfLifeDays 非有限数 || 负数` 都回退 DEFAULT
  并 `logForDebugging`;`saveTunedOracleDecay(t)` `mkdirSync recursive` +
  原子写 + 清缓存;`decayWeight(scoredAtIso, halfLifeDays, nowMs?)`
  (`nowMs` 参数给测试注入 deterministic now);`computeQuantiles(ageDays)`
  返回 `{p25,p50,p75}`(sample<2 全 0);`clampAndStep(v)` 对齐 15 整数倍
  + 夹紧;`computeOracleDecayTuningSuggestion(windowSamples=500) →
  OracleDecayTuningSuggestion { windowSampleCount, p25/50/75AgeDays,
  currentHalfLife, insufficientReason, rows[] }`;`suggestionToNext(s)`
  保留未出现在 rows 的字段;`_resetTunedOracleDecayCacheForTest()`。
  **aggregator 接线**:`aggregateOrganismFitness` 累加器由 `sum` 改为
  `weightedSum + weightSum`,循环前 `const decay = loadTunedOracleDecay()`,
  每条 hit 样本 `const w = decayWeight(s.scoredAt, decay.halfLifeDays);
  weightedSum += s.score*w; weightSum += w`,最终
  `avg = weightSum > 0 ? weightedSum/weightSum : 0`。`aggregateAllOrganisms`
  同构,但 weight **每条 score 只算一次**(不是 per-hit organism)——
  当一条 score 通过 `organismId` 直接归属 + `sessionSet` 反查同时命中
  多个 organism 时,共享同一份 weight,避免按命中数放大。`wins/losses/
  neutrals/trials` 保持整数桶不受 decay 影响(仍按整条样本 +1),
  下游 `autoPromotionEngine.MIN_INVOCATIONS` 对比稳定,不会因 weighted
  小于 1 被破坏。新命令 `/evolve-tune-oracle-decay` 位于
  `commands/evolve-tune-oracle-decay/index.ts`,hidden,参数
  `[--apply|-a] [--window|-w N] [--reset] [--disable]`(`--window` 整数
  1..10000 默认 500;`--apply`/`--reset`/`--disable` 三者两两互斥)。
  Dry-run 打印 `## autoEvolve Oracle Decay Auto-Tuner (Phase 39)` 标题 +
  mode/window/actual count/current halfLifeDays(current=0 时标 `(sentinel:
  decay OFF)`)+ `sample age p25/p50/p75` 统计行 + Suggestion 对齐表 +
  Rationale 逐行理由 + 尾部三提示;`--apply` insufficient 时显式跳过
  保护用户手改(`--apply skipped due to insufficient data; existing
  tuned-oracle-decay.json (if any) is untouched`);就绪则写盘 + Apply
  result 区块含 `will pick up on next aggregate (mtime cache)`;**`--disable`**
  是 Phase 39 独有的 opt-out 路径,显式写 `halfLifeDays=0` 但保留文件作为
  审计记录(区分"从未触碰"和"用户主动关"两种状态);**`--reset`**
  `unlinkSync` 回到 DEFAULT sentinel,文件不存在时 `nothing to reset`。
  **不设 env gate** —— sentinel 设计保证从未 --apply 的环境完全不受
  Phase 39 影响,blast radius 极小。Validated **83/83** across 21
  sections A-V:(A, 7) decayWeight 数学(halfLife=0→1、halfLife=30 age=30
  →0.5、age=60→0.25、age=0→1、未来时间→1、坏 ISO→1、halfLife<0→1);
  (B, 4) load/save + mtime cache(missing→0、save 30→30、bump 30→60
  pickup、坏 schema→fallback 0);(C, 2) <10 样本 insufficient;
  (D, 3) current=0 p75<14 hold + reason mentions fresh;(E, 6) current=0
  p75≥14 first-opt-in 建议 step-aligned+clamped;(F, 4) current=30 ratio
  中间 hold 建议不变;(G, 3) current=15 ratio≥2 relax→30;(H, 3)
  current=120 ratio≤0.3 tighten→105;(I, 1) tighten MIN=7 clamp;
  (J, 1) relax MAX=365 clamp;(K, 5) aggregator 100% backward compat
  —— 10 条不同 age/score,halfLife=0 时 `aggregateOrganismFitness` 和
  `aggregateAllOrganisms` 的 avg 都严格等于 `Σscore/10`;(L, 3)
  halfLife=30 时 weighted avg 与 arithmetic avg 不同 + 精确等于手算
  `Σ(score·0.5^(age/30)) / Σ(0.5^(age/30))`;(M, 4) wins/losses/neutrals
  分桶(0.3 默认阈值)= 5/2/3 不受 decay 影响、trials=10;(N, 2) mtime
  pickup 再改 halfLife=90 aggregator 立刻用新权重,avg 精确等于手算;
  (O, 5) 命令 dry-run 输出(Phase 39 标题、dry-run 标签、current
  halfLifeDays 行、无写盘副作用);(P, 7) parse guards(--window 缺值
  /非数字/越界、未知 flag、--apply+--reset 互斥、--disable+--reset 互斥、
  --apply+--disable 互斥);(Q, 5) --apply 持久化 + APPLY 标签 + wrote
  行 + 文件存在 + halfLife>0 + 15 对齐;(R, 3) --apply 在 insufficient
  时跳过不覆盖已有文件(before==after);(S, 4) --disable 写 halfLifeDays=0
  但保留文件 + 文本含 Disable/halfLifeDays=0;(T, 3) --reset 删除 +
  二次 --reset `nothing to reset`;(U, 3) --window 10 命令路径截断
  `actual count: 10`、--window 500 回到 `actual count: 30`;(V, 5)
  `aggregateAllOrganisms` 对同一 score 命中两个 organism 时 weight
  只算一次 —— `org-v1.avg == org-v2.avg` 精确等值 + 两者 trials=5 +
  手算 weighted avg 5 score age{10,20,30,40,50}@halfLife=30 精确匹配。
  Fixture under `/tmp/autoevolve-phase39-validate/home` with real
  `appendFileSync` writing real FitnessScore NDJSON lines to
  real `fitness.ndjson`;no mocks;script at
  `/tmp/autoevolve-phase39-validate/run.ts` drives real
  `saveTunedOracleDecay` + real `computeOracleDecayTuningSuggestion`
  + real `aggregateOrganismFitness` / `aggregateAllOrganisms`
  + real command `call()` invocations + real `recordSessionOrganismLink`
  for multi-organism scenarios.
- **DONE (Phase 40, Promotion rollback watchdog)**: 解决"晋升后失能"黑洞 ——
  `autoPromotionEngine` 把 organism 从 shadow 推到 canary/stable 是**前向 FSM**,
  但真正跑到 canary/stable 之后如果 Phase 39 加权 `manifest.fitness.avg` 回落,
  老 FSM 没有反向边,只有 `autoArchiveEngine` 在 stable 长期未调用时归档。
  后果:一个晋升失败的 canary/stable 会持续污染 aggregate、继续被 user/session
  触发、拉偏 Oracle 分布,直到用户手动 `/evolve-veto`。Phase 40 **给 FSM 加反向边**:
  `promotionFsm.ALLOWED` 表里 canary 新增 → `shadow`、stable 新增 → `shadow`,
  `types.ts` 的 `TransitionTrigger` 枚举新增 `'auto-rollback'` trigger。新模块
  `services/autoEvolve/emergence/rollbackWatchdog.ts` 暴露
  `scanRollbackCandidates()` / `applyRollback(ev)` / `evaluateRollback(manifest, aggregate, nowMs?)`
  / `findLastPromotionAt(id, toStatus, limit=2000)`。**降级目标是 shadow 而不是 vetoed**
  的纪律:shadow 是"观察位",保留 `invocationCount` / `fitness` 累积数据;给
  organism 第二次自然晋升通道(后续数据变好会重回 canary);shadow 阶段持续
  拉胯会被既有 shadow→vetoed 路径吸收(不重复造轮子);直接 veto 损失晋升
  阶段样本,观察断层,不符合"保留信号"原则。**三重门槛**(任一不满足 hold):
  canary `avg ≤ -0.3 & trials ≥ 3 & ageSincePromotion ≥ 3d`;
  stable `avg ≤ -0.2 & trials ≥ 5 & ageSincePromotion ≥ 7d`。canary 阈值 -0.3
  对齐 Phase 7 `ORGANISM_LOSS_THRESHOLD`(多数样本落 loss 区才降,避免中性
  noise 触发);stable -0.2 更严,因为 stable 已经证过自己,要更大证据强度
  才回退;trials 门槛让刚晋升样本稀少的 organism 不被首条低分拖垮;
  `MIN_AGE_DAYS` 让 organism 至少接一些新样本,不被历史均值锁死。**最近晋升
  时间戳**:`findLastPromotionAt` 从 `promotions.ndjson` 扫所有 `to=<status>`
  transition,取 `max(Date.parse(t.at))` —— **不依赖 `readRecentTransitions`
  的排序方向**(ledger reader 未来改排序不会打穿 watchdog);缺失则 fallback
  到 `manifest.fitness.lastTrialAt`(把"最近一次 fitness 事件"当晋升时刻代理,
  至少保证 MIN_AGE_DAYS 条件不会永远 satisfies 漏判)。**applyRollback**
  调 `promoteOrganism({fromStatus, toStatus:'shadow', trigger:'auto-rollback',
  rationale, oracleScoreSignature: ev.aggregate.lastScoreSignature})` —— ledger
  写带 signature 的 transition,审计可回查"是哪次 fitness 打分触发的 rollback"。
  **与 Phase 38 archive watchdog 的分工**:Phase 38 基于"无调用"(时间信号 →
  stale → archived);Phase 40 基于"有调用但评分差"(fitness 信号 → rollback
  → shadow);两者互补,一个管"死去",一个管"活着但失能"。rollback 回 shadow
  再拉胯走 shadow→vetoed(vetoed 是 ALLOWED 终态无出边),两套闸门串联最终都
  收敛到终态。新命令 `/evolve-rollback-check` 位于
  `commands/evolve-rollback-check/index.ts`,hidden,`[--apply|-a] [--limit|-l N]`
  (`--limit` 1..500 默认 20)。Dry-run 打印 `## autoEvolve Promotion Rollback
  Watchdog (Phase 40)` 标题 + mode + scanned/decisions 计数 + 按
  `decision=rollback` 置顶、同类 avg 升序(最差最上面)的 evaluation 列表
  (每条 `[DECISION] status/name (id) / avg + trials + age + thresholds /
  rationale`);`--apply` 逐条 `applyRollback` ✓/✗ + 汇总 `applied=X failed=Y`。
  **未抽 tuner**(Phase 4x 候选,**已由 Phase 41 关闭** —— 见下一条),v1 先观察用户误降级/漏降级反馈再决定。
  Validated **76/76** across 16 scenarios A-P:(A, 2) FSM 反向边
  `canary→shadow` + `stable→shadow` 都合法;(B, 1) `shadow→canary` 正向边未受
  影响;(C, 3) evaluate canary hold —— avg 刚过阈值(-0.3+0.01)/trials 不足
  (<3)/age 不足(<3d)都 hold;(D, 2) evaluate canary rollback —— 三重门槛
  全过 → decision=rollback + rationale 含 avg/trials/age;(E, 3) evaluate
  stable hold 三个各自原因;(F, 2) evaluate stable rollback 三重门槛;
  (G, 1) evaluate shadow organism → `null`(Phase 40 不管 shadow);
  (H, 4) `findLastPromotionAt` —— 写 4 条 transition(history),取最新
  `canary promote agoDays=3` 而非最早 `agoDays=20`,max-timestamp 不依赖
  ledger 排序方向;(I, 2) `findLastPromotionAt` 未命中 → null;
  fallback 到 `manifest.fitness.lastTrialAt`;(J, 3) `scanRollbackCandidates`
  集成 —— 组装 canary+stable 各 2 个 manifest + 对应 fitness score,
  `scannedCanary=2 scannedStable=2 rollbackCount=N holdCount=M`;
  (K, 3) `applyRollback` 真跑 FSM —— 写 transition to promotions.ndjson、
  manifest 目录搬回 `shadow/`、返回 `ok:true` + signature 透传;
  (L, 2) `applyRollback` 对 `decision=hold` 直接 return `ok:false`
  不碰 FSM;(M, 6) 命令 dry-run 输出(标题、scanned 行、decisions 行、
  按 decision 排序 rollback 靠前、hidden=true、非交互可跑);
  (N, 4) parse guards —— `--limit` 缺值/非数字/0/越界/未知 flag;
  (O, 6) `--apply` 整合 —— 真搬目录、真写 `auto-rollback` transition
  到 ledger、summary `applied=1 failed=0`;(P, 1) 空 scan(无 canary/stable
  organism)打印 `(no canary/stable organisms to evaluate)`。
  Fixture under `/tmp/autoevolve-phase40-validate/home` with real
  `fsm.ALLOWED` asserts + real `organism/{shadow,canary,stable}/<id>/manifest.json`
  + real `fitness.ndjson` + real `promotions.ndjson`;no mocks;
  validation uses local `writeTransition()` `appendFileSync` helper to inject
  deterministic historical `at` values(`recordTransition` 生产路径硬编码
  `at=now`,测试侧绕过而非改生产 API);script at
  `/tmp/autoevolve-phase40-validate/run.ts` drives real `promoteOrganism` +
  real `aggregateOrganismFitness` + real command `call()` invocations.
- **DONE (Phase 41, Rollback threshold auto-tuner)**: 关闭 Phase 40 留的
  "未抽 tuner"尾巴。Phase 40 的 6 个硬编码阈值(canary `avg≤-0.3 & trials≥3 & age≥3d`;
  stable `avg≤-0.2 & trials≥5 & age≥7d`)长期下会出现两类偏差:**误降级(FP)**
  —— organism 被 rollback 后回 shadow 又迅速回暖,说明阈值偏松;**漏降级(FN)**
  —— canary/stable 里 avg 已过线但 trials/age 门槛拦下,evidence-backed 失能
  organism 滞留污染 Oracle。新模块 `services/autoEvolve/oracle/rollbackThresholdTuner.ts`
  把 6 个阈值抽成 `TunedRollbackThresholds { version:1, updatedAt, canary{avgMax, minTrials, minAgeDays}, stable{avgMax, minTrials, minAgeDays} }`
  落盘 `oracle/tuned-rollback-thresholds.json`(新 path helper
  `getTunedRollbackThresholdsPath`);`DEFAULT_TUNED_ROLLBACK_THRESHOLDS` 字段
  值与 Phase 40 硬编码 1:1 相等,文件缺失即行为不变,100% 向后兼容。**信号**:
  `computeFpSignal({rollbackTransitions, fitnessScores, nowMs, observationWindowDays=14})`
  读 `promotions.ndjson` 里 `trigger='auto-rollback'` 的 transition,对每条 event
  在窗口 `[rollbackAt, rollbackAt + 14d]` 找该 organismId 的 FitnessScore,若
  `avg(score) > 0` 则该事件记为 FP(rollback 后本应低迷却迅速回暖)。观察窗口
  未满(`now < rollbackAt + 14d`)的 event 跳过不计,保证统计的 FP 都有足够证据
  时间。`computeFnSignal({evaluations})` 读 `scanRollbackCandidates()` 当前
  decisions,`decision==='hold'` 且 `avg ≤ thresholds.avgMax` 但 trials/age 门槛
  拦下(即 reasons 里出现 `trials < N` 或 `ageSincePromotion < Kd`)的组织算作
  FN 候选(分子);同 status 的全部 hold 组织为分母,得 `fnRate`。**决策规则**:
  `computeRollbackThresholdTuningSuggestion({currentTuned, rollbackTransitions, fitnessScores, evaluations})`
  每个 band(canary/stable)独立判:样本 `< MIN_SAMPLES_TO_TUNE=5` → `insufficient`
  (next === current);`fpRate ≥ 0.5 AND fnRate < 0.3` → **tighten**(avgMax -=0.05,
  minTrials +=1, minAgeDays +=1);`fpRate ≤ 0.1 AND fnRate ≥ 0.3` → **relax**
  (avgMax +=0.05, -1, -1);其它 hold。**步长故意极小**(avgMax ±0.05,trials/age
  ±1)避免单次 tuning 过度偏移,连续跑能逐步逼近最优;clamp 到 `avgMax∈[-0.7,-0.05]`
  × `minTrials∈[1,20]` × `minAgeDays∈[1,30]` 确保 runaway 下也不退化到荒谬值。
  **rollbackWatchdog 接线**:`evaluateRollback` 在 age/dsli 计算前立刻
  `const tuned = loadTunedRollbackThresholds(); const thresholds = status==='canary'?tuned.canary:tuned.stable`,
  替换 Phase 40 的硬编码 `ROLLBACK_CANARY_*` / `ROLLBACK_STABLE_*` 引用
  (`export const` 保留向后兼容);rationale 输出里的 thr{avg≤T,...} 也随 tuned
  值变,形成 self-calibrating 闭环 —— 下一轮 tuner 读到的 event rationale/
  thresholds 已是新值,继续收紧/放宽。`loadTunedRollbackThresholds()` mtime 缓存
  + schema 校验(version≠1/数值域外/NaN → fallback DEFAULT 不覆盖);
  `saveTunedRollbackThresholds(t)` 自动 clamp 再写 + 清缓存,再异常坏 tuned 也
  不会污染热路径。命令 `/evolve-tune-rollback-thresholds [--apply|-a] [--reset] [--limit N]`
  (hidden,`--limit` 1..20000 默认 5000,transitions 和 fitness 共用窗口;
  `--apply` / `--reset` 互斥;`--help`/`-h` 打印 USAGE):**Dry-run(默认)**
  只读 —— 打印 `## autoEvolve Rollback Threshold Auto-Tuner (Phase 41)` 标题、
  mode、`data window: transitions=X (limit=L), fitnessScores=Y (limit=L)`、
  `current scan: canary=... stable=... (rollback=... hold=...)`、Current tuned
  file 三行(canary/stable + updatedAt),然后 Suggestion 区块对齐渲染两个 band
  —— `[CANARY/STABLE] decision=... signals: rollbackSamples/fpCount/fpRate/fnCandidates/fnRate`,
  三行 `avgMax/minTrials/minAgeDays: X→Y (+N)` delta 带对齐 + 正负号 + `(unchanged)`
  语义,`rationale:` 行说明决策理由。末尾 `--apply`/`--reset` 提示。**`--apply`**:
  两个 band 都 `insufficient/hold` 时显式打印 `--apply skipped: both bands insufficient/hold;
  existing tuned-rollback-thresholds.json (if any) is untouched`(保护用户手改
  不被覆盖);否则 `saveTunedRollbackThresholds(suggestion.nextTuned)`,追加
  `Apply result:` 区块(`wrote <path>` / `updatedAt` / 新 canary+stable 字段 /
  `rollbackWatchdog will pick up new thresholds on next evaluateRollback (mtime cache)`)。
  **`--reset`**:`unlinkSync tuned-rollback-thresholds.json` + 清缓存 + `will fall back
  to Phase 40 DEFAULT on next evaluate`;不存在则 `nothing to reset; rollbackWatchdog
  is already using Phase 40 DEFAULT (-0.3/3/3d & -0.2/5/7d)`。Parse guards 拒未知
  flag、`--limit` 缺值/非正整数/越界(1..20000)、`--apply --reset`
  互斥。**不设 env gate** —— tuner 只写 `oracle/tuned-rollback-thresholds.json`
  一个文件,blast radius 仅限 rollback 阈值;sentinel 为"文件缺失 = Phase 40
  DEFAULT",保证从未 `--apply` 过的环境 100% 等同 Phase 40。**与 Phase 37/38 的
  分工**:Phase 37 管 promotion tier 阈值(shadow→canary→stable 硬编码步进);
  Phase 38 管 auto-stale 阈值(stable→archived 时间门槛);Phase 41 管 rollback
  阈值(canary/stable→shadow fitness 门槛) —— 三个 tuner 职责清晰分片,各写
  独立 `tuned-*.json`,互不打架,配合 Phase 39 `tuned-oracle-decay.json` 和
  Phase 24 `tuned-thresholds.json` + Phase 27 `tuned-oracle-weights.json`,覆盖
  autoEvolve 所有 FSM 关键阈值 + Oracle 聚合参数的自调节面。Registered in
  `commands.ts` right after `evolveRollbackCheck`.
- **Threshold auto-tuning** (Phase 14 candidate, CLOSED by Phase 37+38+41):
  ~~auto-promotion `SHADOW_TO_CANARY_*` / `CANARY_TO_STABLE_*`~~ 已被
  Phase 37 覆盖;~~auto-archive `STALE_STABLE_UNUSED_DAYS` /
  `STALE_STABLE_MIN_AGE_DAYS`~~ 已被 Phase 38 覆盖;~~rollback watchdog
  `ROLLBACK_CANARY_*` / `ROLLBACK_STABLE_*`~~ 已被 Phase 41 覆盖。整个
  Phase 14 候选项的阈值硬编码问题彻底关闭 —— promotion / archive / rollback
  三侧都在 `oracle/tuned-*.json` 下 mtime-cached 自调节,±步长保守,insufficient
  自守,文件缺失 100% 行为回退到原硬编码。

## References

- Design doc: `docs/self-evolution-kernel-2026-04-22.md` (§1-11 + appendices)
- Sibling kernels: `scheduler-kernel/SKILL.md`, `dream-pipeline/SKILL.md`
- Decision log: design doc §11 (2026-04-22 user ratifications)
