#!/usr/bin/env node
/**
 * gate-hook — 薄壳：ZCode hook 事件 → lib/gate-core 判定。
 * PostToolUse(Edit|Write 等) → 记脏；Stop → 把关，红/回归/新增失败 exit 2 打回。
 */
import fs from 'node:fs'
import { findRoot, markEdit, runGate, log, stateFor } from '../lib/gate-core.mjs'

let raw = ''
for await (const chunk of process.stdin) raw += chunk
let input = {}
try { input = JSON.parse(raw || '{}') } catch {}
const event = input.hook_event_name || input.hookEventName || ''
const projectRoot = findRoot(input.cwd || process.env.ZCODE_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd())
const st = stateFor(projectRoot)

if (event === 'PostToolUse') {
  const fp = input?.tool_input?.file_path || input?.tool_input?.notebook_path || ''
  if (fp) markEdit(projectRoot, fp)
  process.exit(0)
}

if (event === 'Stop') {
  if (process.env.TEST_GATE_SKIP === '1') {
    try { fs.unlinkSync(st.markerPath) } catch {}
    log(st, 'SKIP env — 跳过一次')
    process.exit(0)
  }
  const r = runGate(projectRoot, {})
  for (const m of r.messages || []) process.stderr.write(`[test-gate] ${m}\n`)
  if (r.tail) process.stderr.write(r.tail + '\n')
  if (r.decision === 'block') { log(st, `打回 reason=${r.reason}`); process.exit(2) }
  process.exit(0)
}
process.exit(0)
