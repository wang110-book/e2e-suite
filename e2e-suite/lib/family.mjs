/**
 * family — e2e-suite 家族成员的发现与编排计划（纯读，宿主无关）。
 *
 * 契约块（见 skills/frontend-backend-e2e/references/suite-contract.md）：
 *   - phase: env|design|exec|assert|report|custom
 *   - before / after: 目标可以是 phase 名、成员名，逗号分隔多个；可带括号注释
 *
 * 排序：相位默认序 env→design→exec→assert→report，custom 由 before/after 定位；
 *       before/after 约束在相位序之上做稳定拓扑修正，检测到环则保留相位序并报告冲突。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

export const PHASE_ORDER = ['env', 'design', 'exec', 'assert', 'report']
const KNOWN_PHASES = new Set([...PHASE_ORDER, 'custom'])

const CONTRACT_HEAD = /^##\s*家族契约（e2e-suite）\s*$/m
// detached 只认**标题行**。曾用全文匹配，结果 canary-bootstrap 因为在正文里引用
// "家族契约（e2e-suite-暂停）"来解释自脱离机制，被整份判成 detached 而永久消失。
const CONTRACT_DETACHED = /^##\s*家族契约（e2e-suite-暂停）\s*$/m

export function skillSearchRoots(projectRoot) {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const roots = [path.join(here, '..', 'skills')]
  const userSkills = path.join(os.homedir(), '.zcode', 'skills')
  if (!roots.includes(userSkills)) roots.push(userSkills)
  if (projectRoot) roots.push(path.join(projectRoot, '.zcode', 'skills'))
  return roots
}

// "assert（默认最后执行）" → "assert"；"a, b" → ["a","b"]
export function splitTargets(value) {
  if (!value) return []
  return String(value)
    .replace(/[（(][^）)]*[）)]/g, '')
    .split(/[,，]/)
    .map(s => s.trim())
    .filter(Boolean)
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
  if (!phase || !KNOWN_PHASES.has(phase)) return null
  return {
    phase,
    before: get('before'),
    after: get('after'),
    inputs: get('inputs'),
    outputs: get('outputs'),
    idempotent: get('idempotent'),
    ephemeral: get('ephemeral'),
  }
}

export function discoverFamily(projectRoot) {
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
  return members
}

/**
 * 生成执行计划。
 * @returns {{plan: string[], conflicts: string[]}}
 */
export function buildPlan(members) {
  const byName = new Map(members.map(m => [m.name, m]))
  const rank = (m) => {
    const i = PHASE_ORDER.indexOf(m.phase)
    return i < 0 ? PHASE_ORDER.length : i   // custom 默认排在 report 之后
  }
  const order = members.slice().sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
  const plan = order.map(m => m.name)
  const conflicts = []

  // 约束统一成边：a → b（a 必须先于 b）
  const edges = new Map(plan.map(n => [n, new Set()]))
  const addEdge = (from, to) => { if (from !== to && edges.has(from) && edges.has(to)) edges.get(from).add(to) }

  for (const m of members) {
    for (const target of splitTargets(m.after)) {
      if (byName.has(target)) {
        addEdge(target, m.name)                     // 成员名：该成员必须先于本成员
      } else if (KNOWN_PHASES.has(target)) {
        for (const other of members) {
          if (other.name !== m.name && other.phase === target) addEdge(other.name, m.name)
        }
      } else {
        conflicts.push(`${m.name}: after 目标 "${target}" 不是已知 phase 或成员，已忽略`)
      }
    }
    for (const target of splitTargets(m.before)) {
      if (byName.has(target)) {
        addEdge(m.name, target)
      } else if (KNOWN_PHASES.has(target)) {
        for (const other of members) {
          if (other.name !== m.name && other.phase === target) addEdge(m.name, other.name)
        }
      } else {
        conflicts.push(`${m.name}: before 目标 "${target}" 不是已知 phase 或成员，已忽略`)
      }
    }
  }

  // 稳定拓扑：每轮从"当前可执行"里取相位序最靠前的（保持默认序，只被约束推翻）
  const baseIndex = new Map(plan.map((n, i) => [n, i]))
  const indeg = new Map(plan.map(n => [n, 0]))
  for (const [, outs] of edges) for (const to of outs) indeg.set(to, (indeg.get(to) || 0) + 1)
  const ready = plan.filter(n => indeg.get(n) === 0)
  const sorted = []
  while (ready.length) {
    ready.sort((a, b) => baseIndex.get(a) - baseIndex.get(b))
    const n = ready.shift()
    sorted.push(n)
    for (const to of edges.get(n) || []) {
      indeg.set(to, indeg.get(to) - 1)
      if (indeg.get(to) === 0) ready.push(to)
    }
  }
  if (sorted.length !== plan.length) {
    const stuck = plan.filter(n => !sorted.includes(n))
    conflicts.push(`before/after 约束成环，以下成员已回退到相位序：${stuck.join(', ')}`)
    for (const n of stuck) sorted.push(n)
  }
  return { plan: sorted, conflicts }
}
