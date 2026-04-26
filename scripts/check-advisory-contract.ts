#!/usr/bin/env bun
// Advisory Contract Drift Check(Phase 97, 2026-04-24)
//
// What it does:
//   - Runs the three-layer contract drift detection from Ph92-96:
//       Layer 1 (Ph95):  declaration ↔ contract   — static, always meaningful
//       Layer 2 (Ph92):  ring ruleId → contract   — runtime, needs ring signal
//       Layer 3 (Ph96):  ring category → declaration — runtime, catches template
//                         literal changes that forgot to update declaration
//   - Prints a pass/fail summary per layer
//   - Exits 0 if all layers are clean, 1 if any drift detected, 2 on error
//
// Run:
//   bun run scripts/check-advisory-contract.ts
//
// Intent:
//   The Advisory Contract is a tri-party agreement between:
//     - advisor.ts template literals (who actually emits ruleIds)
//     - advisor.PER_ENTITY_CATEGORIES_EMITTED (self-declaration)
//     - advisoryContract.PER_ENTITY_ADVISORY_RULES (consumer's mapping)
//   Any pair may silently drift. This script makes the invariant
//   machine-checkable for pre-commit / CI use.
//
// Non-goals:
//   - Does NOT auto-fix drift (Ph94 suggestedContractAdditions is adv-only).
//   - Does NOT mutate any ledgers/files.

import { getAdvisoryMiningDiagnostics } from '../src/services/autoEvolve/emergence/patternMiner.js'

type Result = {
  layer: string
  pass: boolean
  detail: string
}

function checkLayers(): Result[] {
  // getAdvisoryMiningDiagnostics 兼任三层检测:
  //   fm.orphanContractCategories / missingContractCategories → Ph95
  //   fm.unmappedSample / unmappedWithEntity                   → Ph92
  //   fm.undeclaredEmittedCategories                           → Ph96
  const diag = getAdvisoryMiningDiagnostics({ topN: 0 })
  const fm = diag.fusionMapping
  const results: Result[] = []

  // Layer 1: Ph95 静态 —— 不依赖 ring,永远可判决
  const l1Clean =
    fm.orphanContractCategories.length === 0 &&
    fm.missingContractCategories.length === 0
  results.push({
    layer: 'L1 declaration↔contract (Ph95)',
    pass: l1Clean,
    detail: l1Clean
      ? 'orphan=[], missing=[]'
      : `orphan=[${fm.orphanContractCategories.join(', ')}] ` +
        `missing=[${fm.missingContractCategories.join(', ')}]`,
  })

  // Layer 2: Ph92 —— 需要 ring 有信号才有意义
  const l2Clean = fm.unmappedWithEntity === 0
  results.push({
    layer: 'L2 ring→contract (Ph92)',
    pass: l2Clean,
    detail: l2Clean
      ? 'unmappedWithEntity=0'
      : `unmappedWithEntity=${fm.unmappedWithEntity} ` +
        `sample=[${fm.unmappedSample.join(', ')}] ` +
        `suggested=${JSON.stringify(fm.suggestedContractAdditions)}`,
  })

  // Layer 3: Ph96 —— 需要 ring 有信号才有意义
  const l3Clean = fm.undeclaredEmittedCategories.length === 0
  results.push({
    layer: 'L3 ring→declaration (Ph96)',
    pass: l3Clean,
    detail: l3Clean
      ? 'undeclared=[]'
      : `undeclared=[${fm.undeclaredEmittedCategories.join(', ')}]`,
  })

  return results
}

function main(): void {
  console.log('[advisory-contract-check]')
  let results: Result[]
  try {
    results = checkLayers()
  } catch (e) {
    console.error('ERROR during check:', (e as Error).message)
    process.exit(2)
  }

  const pad = Math.max(...results.map(r => r.layer.length))
  let allPass = true
  for (const r of results) {
    const mark = r.pass ? '✓' : '✗'
    if (!r.pass) allPass = false
    console.log(`  ${mark} ${r.layer.padEnd(pad)}  ${r.detail}`)
  }

  if (allPass) {
    console.log('\nAll 3 layers clean — advisory contract integrity OK')
    process.exit(0)
  } else {
    console.log(
      '\nDrift detected — see /evolve-status Advisory Funnel for remediation hints',
    )
    process.exit(1)
  }
}

main()
