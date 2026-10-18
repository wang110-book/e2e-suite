#!/usr/bin/env node
// gate-cli.mjs — test-gate 的平台无关命令行入口（跨宿主/CI 迁移用）
//
// WHY THIS EXISTS (2026-10-18):
//   gate-core.mjs 是纯判定引擎（零宿主依赖），但此前只有两个宿主薄壳：
//   ZCode 的 Stop hook 与 MCP server。把门禁迁到别的平台（CI 流水线、
//   其它 agent 宿主、裸终端）时，宿主壳要重写、核心不动——但核心缺一个
//   通用 CLI 入口。本文件补上：任何能跑 `node` 的地方，一行命令即可调用门禁。
//
// Usage:
//   node gate-cli.mjs run   [projectRoot]   # 完整判定（等价 MCP test_gate_run）
//   node gate-cli.mjs status [projectRoot]  # 只读状态（等价 test_gate_status）
//   node gate-cli.mjs reset  [projectRoot]  # 清基线（等价 test_gate_reset）
//   projectRoot 省略 = 当前目录（向上锚定由 gate-core 处理）
//
// Exit codes: 0 = pass / 1 = block / 2 = 用法错误 / 3 = unevaluated（门禁无法评估：
// 测试器缺失、超时、输出溢出、输出不可解析——CI 应视为"未通过"或单独告警）。
// stdout 输出 JSON（可被任意 CI 解析），stderr 输出人读摘要。
import { findRoot, runGate, status, reset } from './gate-core.mjs'

const [cmd, argRoot] = process.argv.slice(2)
const root = argRoot ? findRoot(argRoot) : findRoot(process.cwd())

if (!root || !['run', 'status', 'reset'].includes(cmd)) {
  console.error('usage: node gate-cli.mjs <run|status|reset> [projectRoot]')
  process.exit(2)
}

let out, code = 0
if (cmd === 'run') {
  const r = runGate(root, { force: true })
  out = r
  code = r.decision === 'pass' ? 0 : r.decision === 'block' ? 1 : 3
} else if (cmd === 'reset') {
  out = reset(root)
} else {
  out = status(root)
}
console.log(JSON.stringify(out, null, 2))
console.error(cmd === 'run'
  ? `gate: ${out.decision} (${out.reason})`
  : `gate: ${cmd} done`)
process.exit(code)
