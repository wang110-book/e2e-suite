#!/usr/bin/env node
/**
 * e2e-suite MCP server — 把门禁与家族的可查询能力经标准 MCP 协议暴露：
 *   test_gate_status / test_gate_run / test_gate_reset   （门禁）
 *   family_skills                                         （家族成员发现 + 编排计划）
 * 拦截本身留在 hooks（MCP 工具只能被模型主动调用，无强制力）。
 * 实现：newline-delimited JSON-RPC 2.0 over stdio（MCP stdio transport），零依赖。
 */
import { findRoot, runGate, status, reset } from '../lib/gate-core.mjs'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const SERVER = { name: 'e2e-suite', version: '1.1.0' }

// ---------- 家族契约发现（纯读，宿主无关） ----------
// 扫描根：插件自带 skills/（权威发布源）+ 用户运行时 skills 目录 + 项目级 .zcode/skills。
// 解析 SKILL.md 的「## 家族契约（e2e-suite）」块；
// 「e2e-suite-暂停」标记（detached）与无契约块的一律不入列。
const CONTRACT_HEAD = /^##\s*家族契约（e2e-suite）\s*$/m
const CONTRACT_DETACHED = /家族契约（e2e-suite-暂停）/
const PHASE_ORDER = ['env', 'design', 'exec', 'assert', 'report']

function skillSearchRoots(projectRoot) {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const roots = [path.join(here, '..', 'skills')]
  const userSkills = path.join(os.homedir(), '.zcode', 'skills')
  if (!roots.includes(userSkills)) roots.push(userSkills)
  if (projectRoot) roots.push(path.join(projectRoot, '.zcode', 'skills'))
  return roots
}

function parseContract(md) {
  const body = md.split(CONTRACT_HEAD)[1]
  if (!body) return null
  const block = body.split(/^##\s/m)[0]
  const get = (key) => {
    const m = new RegExp(`^-\\s*${key}:\\s*(.+)$`, 'm').exec(block)
    return m ? m[1].trim() : ''
  }
  const phase = get('phase')
  if (!phase) return null
  return {
    phase, before: get('before'), after: get('after'),
    inputs: get('inputs'), outputs: get('outputs'), idempotent: get('idempotent'),
  }
}

function discoverFamily(projectRoot) {
  const members = []
  const seen = new Set()
  for (const root of skillSearchRoots(projectRoot)) {
    let dirs = []
    try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name) }
    catch { continue }
    for (const d of dirs) {
      if (seen.has(d)) continue
      const f = path.join(root, d, 'SKILL.md')
      let md
      try { md = fs.readFileSync(f, 'utf8') } catch { continue }
      if (CONTRACT_DETACHED.test(md)) continue
      if (!CONTRACT_HEAD.test(md)) continue
      const c = parseContract(md)
      if (!c) continue
      seen.add(d)
      members.push({ name: d, source: path.dirname(f), ...c })
    }
  }
  // 编排计划：phase 默认序 + before/after 约束（简单稳定排序，冲突时以声明为准提示人工裁决）
  const rank = (m) => {
    let r = PHASE_ORDER.indexOf(m.phase)
    if (r < 0) r = 99 // custom：先按 after 挂到声明的槽位后
    return r
  }
  const plan = members
    .slice()
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
    .map(m => m.name)
  // custom 成员有 after 的，尽量排到该成员之后（一次修正，不迭代防环）
  for (const m of members.filter(x => x.after)) {
    const anchor = plan.find(n => n === m.after.split(/[,，]/)[0].trim())
    const i = plan.indexOf(m.name)
    if (anchor && i >= 0 && plan.indexOf(anchor) >= i) {
      plan.splice(i, 1); plan.splice(plan.indexOf(anchor) + 1, 0, m.name)
    }
  }
  return { members, plan }
}

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
  {
    name: 'family_skills',
    description: '发现 e2e-suite 测试技能家族的在册成员（解析各 SKILL.md 的家族契约块），返回成员清单（phase/before/after/inputs/outputs）与按槽位拓扑排序的编排计划。这是家族测试的 MCP 入口：拿到计划后，用宿主 Skill 工具按名单逐个加载成员执行（MCP 工具本身不加载技能——加载与计划确认是宿主/用户的职责，编排红线不变）。可选 phase 过滤。',
    inputSchema: {
      type: 'object',
      properties: {
        project_root: { type: 'string', description: '可选：项目根（扫描其 .zcode/skills 项目级成员）' },
        phase: { type: 'string', enum: ['env', 'design', 'exec', 'assert', 'report', 'custom'], description: '可选：只看某槽位的成员' },
      },
      additionalProperties: false,
    },
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
  if (name === 'family_skills') {
    const { members, plan } = discoverFamily(root)
    const filtered = args?.phase ? members.filter(m => m.phase === args.phase) : members
    return {
      members: filtered,
      plan: args?.phase ? plan.filter(n => filtered.some(m => m.name === n)) : plan,
      howToUse: '把 plan 名单与顺序呈现给用户确认后，用宿主 Skill 工具逐个加载成员执行；' +
        'env 成员先跑、产物落盘后 exec 才开跑（下游只认落盘产物）。',
    }
  }
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
