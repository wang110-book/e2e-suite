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
  // unevaluated：无法评估（超时/工具缺失/输出不可解析）——不卡会话，但必须显式告警，
  // 绝不能让它看起来像一次绿色的把关
  if (r.decision === 'unevaluated') {
    log(st, `无法评估 reason=${r.reason}`)
    process.stderr.write(`[test-gate] ⚠ 本次门禁无法评估（${r.reason}）——未通过把关，请手动确认测试状态\n`)
  }
  process.exit(0)
}
process.exit(0)
