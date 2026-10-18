#!/usr/bin/env node
/**
 * test-gate MCP server — 把门禁的可查询能力经标准 MCP 协议暴露：
 *   test_gate_status / test_gate_run / test_gate_reset
 * 拦截本身留在 hooks（MCP 工具只能被模型主动调用，无强制力）。
 * 实现：newline-delimited JSON-RPC 2.0 over stdio（MCP stdio transport），零依赖。
 */
import { findRoot, runGate, status, reset } from '../lib/gate-core.mjs'

const SERVER = { name: 'test-gate', version: '0.1.0' }
const TOOLS = [
  {
    name: 'test_gate_status',
    description: '查询当前项目测试门禁状态：检测到的测试栈、脏文件清单、基线（已知失败）、绿史、门禁日志尾部。只读。',
    inputSchema: { type: 'object', properties: { project_root: { type: 'string', description: '项目根绝对路径；省略则用服务器工作目录向上锚定' } }, additionalProperties: false },
  },
  {
    name: 'test_gate_run',
    description: '立即完整跑一次门禁（构建+测试+基线判定），不等 Stop 事件。会真实执行项目测试栈，大项目可达数分钟。返回 decision=pass|block 与失败明细。',
    inputSchema: { type: 'object', properties: { project_root: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'test_gate_reset',
    description: '清除该项目门禁状态：基线、绿史、脏标记全部删除（回到"首红重新立基线"的宽容态）。仅当你确实想重新宽容存量红时用。',
    inputSchema: { type: 'object', properties: { project_root: { type: 'string' } }, additionalProperties: false },
  },
]

function resolveRoot(args) {
  return findRoot(args?.project_root || process.env.ZCODE_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd())
}

function callTool(name, args) {
  const root = resolveRoot(args)
  if (name === 'test_gate_status') return status(root)
  if (name === 'test_gate_run') {
    const r = runGate(root, { force: true })
    return { projectRoot: root, ...r }
  }
  if (name === 'test_gate_reset') return { projectRoot: root, ...reset(root) }
  throw new Error(`unknown tool: ${name}`)
}

function reply(obj) { process.stdout.write(JSON.stringify(obj) + '\n') }
function respond(id, result) { reply({ jsonrpc: '2.0', id, result }) }
function respondErr(id, code, message) { reply({ jsonrpc: '2.0', id, error: { code, message } }) }

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    const { id, method, params } = msg
    if (id === undefined) continue // notification: initialized / cancelled 等，无需应答
    try {
      if (method === 'initialize') {
        respond(id, { protocolVersion: params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: SERVER })
      } else if (method === 'ping') {
        respond(id, {})
      } else if (method === 'tools/list') {
        respond(id, { tools: TOOLS })
      } else if (method === 'tools/call') {
        const out = callTool(params?.name, params?.arguments)
        respond(id, { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], isError: false })
      } else {
        respondErr(id, -32601, `method not found: ${method}`)
      }
    } catch (e) {
      respondErr(id ?? null, -32603, String(e?.message || e))
    }
  }
})
process.stdin.on('end', () => process.exit(0))
