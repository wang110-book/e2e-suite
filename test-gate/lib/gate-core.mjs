#!/usr/bin/env node
/**
 * gate-core — 测试门禁共享内核。
 * 被两个薄壳复用：hooks/gate-hook.mjs（事件驱动拦截）与 mcp/server.mjs（可查询能力面）。
 * 语义与 ~/.zcode/hooks/test-gate.mjs 全局版完全一致（5 场景生命周期实测过的逻辑，原样迁移）：
 *   PostToolUse(Edit|Write 碰 src/tests/manifest) 记脏 → Stop 跑栈；
 *   首红立基线放行 → 只拦新增失败名 → 全绿清基线+立绿史 → 绿史后红=回归直接打回。
 * 状态目录 %TEMP%\zcode-test-gate\<项目路径哈希> 不变，与全局版共享同一份基线。
 * 注意：本模块禁止顶层读取 stdin / 计算 cwd——stdin 归各薄壳自己管（MCP 用它传 JSON-RPC）。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'

const ANCHORS = ['package.json', 'pyproject.toml', 'setup.py', 'requirements.txt', 'Cargo.toml',
  'go.mod', 'CMakeLists.txt', 'Makefile', 'makefile', 'build.ninja', 'meson.build']

export function findRoot(start) {
  let dir = path.resolve(start)
  for (let i = 0; i < 6; i++) {
    try {
      const entries = fs.readdirSync(dir)
      if (entries.some(e => ANCHORS.includes(e) || e.endsWith('.sln'))) return dir
    } catch { break }
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  return path.resolve(start)
}

export function stateFor(projectRoot) {
  const key = crypto.createHash('sha1').update(projectRoot.toLowerCase().replace(/[\\/]+/g, '/')).digest('hex').slice(0, 12)
  const stateDir = path.join(os.tmpdir(), 'zcode-test-gate', key)
  return {
    key, stateDir,
    markerPath: path.join(stateDir, 'dirty'),
    baselinePath: path.join(stateDir, 'baseline.json'),
    everGreenPath: path.join(stateDir, 'ever-green'),
    quarantinePath: path.join(stateDir, 'quarantine.json'),
    logPath: path.join(stateDir, 'gate.log'),
  }
}

export function log(st, msg) {
  try {
    fs.mkdirSync(st.stateDir, { recursive: true })
    if (fs.existsSync(st.logPath) && fs.statSync(st.logPath).size > 262144) fs.truncateSync(st.logPath, 0)
    fs.appendFileSync(st.logPath, `${new Date().toISOString()} ${msg}\n`)
  } catch {}
}

const CODE_EXT = new Set(['.c', '.cc', '.cpp', '.cxx', '.h', '.hpp', '.hxx', '.py', '.js', '.mjs', '.cjs',
  '.ts', '.tsx', '.jsx', '.go', '.rs', '.cs', '.java', '.kt', '.rb', '.php', '.swift', '.scala',
  '.html', '.htm', '.css', '.scss', '.less', '.vue', '.svelte'])
const MANIFEST = new Set(['package.json', 'Cargo.toml', 'CMakeLists.txt', 'go.mod', 'pyproject.toml',
  'setup.py', 'requirements.txt', 'Makefile', 'meson.build', 'build.ninja'])
export function isCodePath(rel) {
  const r = rel.replace(/\\/g, '/')
  const base = r.split('/').pop() || ''
  if (/^(tests?|src|lib|spec|pkg|cmd)\//i.test(r)) return true
  if (CODE_EXT.has(path.extname(base))) return true
  if (MANIFEST.has(base) || base.endsWith('.sln') || base.endsWith('.csproj')) return true
  return false
}

export function markEdit(projectRoot, filePath) {
  const st = stateFor(projectRoot)
  const rel = path.relative(projectRoot, path.resolve(projectRoot, filePath)).replace(/\\/g, '/')
  if (!rel.startsWith('..') && isCodePath(rel)) {
    fs.mkdirSync(st.stateDir, { recursive: true })
    fs.appendFileSync(st.markerPath, rel + '\n')
  }
  return { marked: true }
}

export function detect(projectRoot) {
  const p = (f) => path.join(projectRoot, f)
  const read = (f) => { try { return fs.readFileSync(p(f), 'utf8') } catch { return '' } }
  const has = (f) => { try { return fs.existsSync(p(f)) } catch { return false } }
  const lsSafe = (d) => { try { return fs.readdirSync(d) } catch { return [] } }

  if (has('package.json')) {
    let pkg = {}
    try { pkg = JSON.parse(read('package.json')) } catch {}
    const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') ? 'bun' : 'npm'
    if (pkg.scripts && pkg.scripts.test && !/no tests? configured|no test specified|placeholder/i.test(pkg.scripts.test)) {
      return { runner: 'jest', test: { cmd: pm, args: pm === 'npm' ? ['test', '--silent'] : ['run', 'test'] },
        parse: (o) => [...o.matchAll(/^\s*(?:✕|×|✗|✖)\s+(.+)$/gm)].map(m => m[1].trim()) }
    }
  }
  if (/(^\s*pytest|python_requires.*pytest|\bpytest\b)/m.test(read('pyproject.toml')) || /\bpytest\b/.test(read('requirements.txt'))
      || has('pytest.ini') || has('tox.ini') || (has('setup.cfg') && /pytest/.test(read('setup.cfg')))) {
    let hasTests = has('tests')
    try { hasTests = hasTests || fs.readdirSync(projectRoot).some(f => f.startsWith('test_') && f.endsWith('.py')) } catch {}
    if (hasTests) {
      return { runner: 'pytest', test: { cmd: 'python', args: ['-m', 'pytest', '-q', '--no-header', '-rf'] },
        select: selectPytest(projectRoot),
        parse: (o) => [...o.matchAll(/^FAILED\s+(\S+)/gm)].map(m => m[1]),
        failCount: (o) => { const m = o.match(/(\d+) failed/); return m ? +m[1] : null } }
    }
  }
  if (has('Cargo.toml')) return { runner: 'cargo', test: { cmd: 'cargo', args: ['test'] },
    parse: (o) => [...o.matchAll(/^\s*test\s+(\S+)\s+\.\.\.\s+FAILED/gm)].map(m => m[1]) }
  if (has('go.mod')) return { runner: 'gotest', test: { cmd: 'go', args: ['test', './...'] },
    select: selectGo(projectRoot),
    parse: (o) => [...o.matchAll(/--- FAIL:\s+(\S+)/g)].map(m => m[1]) }
  const sln = lsSafe(projectRoot).find(f => f.endsWith('.sln'))
  if (sln) return { runner: 'dotnet', test: { cmd: 'dotnet', args: ['test', sln, '--nologo', '-v', 'q'] },
    parse: (o) => [...o.matchAll(/Failed\s+(\S+)/gi)].map(m => m[1]) }
  if (has('CMakeLists.txt') && has('build') && /add_executable\(\s*unit_tests/.test(read('CMakeLists.txt'))) {
    let cmakeBin = 'cmake'
    try {
      const m = read(path.join('build', 'CMakeCache.txt')).match(/^CMAKE_COMMAND:INTERNAL=(.+)$/m)
      if (m) cmakeBin = m[1].replace(/\r/g, '').trim()
    } catch {}
    const exeCandidates = ['build/Release/unit_tests.exe', 'build/Debug/unit_tests.exe', 'build/unit_tests']
      .map(x => p(x)).filter(x => fs.existsSync(x))
    if (exeCandidates.length) {
      return { runner: 'unit_tests_ex',
        build: [{ cmd: cmakeBin, args: ['--build', 'build', '--target', 'unit_tests', '--config', 'Release'], timeout: 360_000 }],
        test: { cmd: exeCandidates[0], args: [], timeout: 240_000 },
        parse: (o) => [...o.matchAll(/^\[FAIL\]\s+(\S+)/gm)].map(m => m[1]) }
    }
  }
  const mk = read('Makefile') || read('makefile')
  if (/^test\s*:/m.test(mk)) return { runner: 'make', test: { cmd: 'make', args: ['test'] }, parse: () => [] }
  return null
}

// ── TIA 影响面选择（Datadog/mabl 口径：只跑受影响；映射不全 → 安全侧全量，只多跑不漏跑）──
// 脏文件为空 → 返回 null（调用方退回全量）。映射失败/共享面命中 → null（全量）。
function selectPytest(projectRoot) {
  return (_root, dirtyFiles) => {
    if (!dirtyFiles || !dirtyFiles.length) return null
    const targets = new Set()
    const testDirs = ['tests', 'test']
    for (const f of dirtyFiles) {
      const base = f.split('/').pop() || ''
      // 测试文件本身直接进目标
      if (/^test_.*\.py$/.test(base) || /\.py$/.test(base) && testDirs.includes(f.split('/')[0])) { targets.add(f); continue }
      // 源文件 → 同名测试（经典 test_<module>.py 命名映射）；找不到 → 全量兜底
      if (/\.py$/.test(base)) {
        const guess = testDirs.map(d => `${d}/test_${base.replace(/\.py$/, '')}.py`)
        const found = guess.find(g => fs.existsSync(path.join(projectRoot, g)))
        if (found) targets.add(found); else return null
      } else return null // 配置/数据类改动影响面不可靠 → 全量
    }
    if (!targets.size) return null
    return { args: ['-m', 'pytest', '-q', '--no-header', '-rf', ...[...targets].sort()], note: `${targets.size} 个映射目标` }
  }
}
function selectGo(projectRoot) {
  return (_root, dirtyFiles) => {
    if (!dirtyFiles || !dirtyFiles.length) return null
    const pkgs = new Set()
    for (const f of dirtyFiles) {
      if (/\.go$/.test(f) && !f.startsWith('vendor/')) pkgs.add('./' + (f.split('/').slice(0, -1).join('/') || '.'))
      else return null // 非 .go 改动（go.mod/配置）→ 全量
    }
    if (!pkgs.size) return null
    return { args: ['test', ...[...pkgs].map(x => x === './.' ? './' : x).sort()], note: `${pkgs.size} 个包` }
  }
}

const sig = (s) => crypto.createHash('sha1').update(s).digest('hex')

function loadBaseline(st) { try { return JSON.parse(fs.readFileSync(st.baselinePath, 'utf8')) } catch { return null } }
function saveBaseline(st, projectRoot, names, signature) {
  fs.mkdirSync(st.stateDir, { recursive: true })
  fs.writeFileSync(st.baselinePath, JSON.stringify({ at: new Date().toISOString(), project: projectRoot, failing: names, count: names.length, signature: signature || null }, null, 2))
}

// ── 抖动隔离（QAPractices 口径的 hook 场景简化版）──────────────
// 结构 { [testName]: { flakyHits, greenStreak, quarantinedAt } }
// 规则：基线外新增失败 → 重跑一次；翻绿 = 一次 flakyHit；flakyHits ≥ 2 → 隔离（不拦，登记可见）。
//       隔离期每遇到一次"全绿回合"greenStreak+1；≥10 出隔离（Reintegrate）。重跑仍红 = 真回归，照常打回。
const FLAKY_HITS_TO_QUARANTINE = 2
const REINTEGRATE_GREEN_STREAK = 10
function loadQuarantine(st) { try { return JSON.parse(fs.readFileSync(st.quarantinePath, 'utf8')) } catch { return {} } }
function saveQuarantine(st, q) {
  fs.mkdirSync(st.stateDir, { recursive: true })
  fs.writeFileSync(st.quarantinePath, JSON.stringify(q, null, 2))
}
function quarantinedNames(q) { return Object.keys(q).filter(k => q[k].quarantinedAt) }

export function runStep(projectRoot, s) {
  const isCmdShell = process.platform === 'win32' && /^(npm|pnpm|yarn|bun|npx)$/.test(s.cmd)
  if (isCmdShell) {
    const args = (s.args || []).map(a => /\s/.test(a) ? JSON.stringify(a) : a)
    return spawnSync([s.cmd, ...args].join(' '), { cwd: projectRoot, timeout: s.timeout || 300_000, encoding: 'utf8', shell: true, windowsHide: true })
  }
  return spawnSync(s.cmd, s.args || [], { cwd: projectRoot, timeout: s.timeout || 300_000, encoding: 'utf8', windowsHide: true })
}

/** 完整门禁判定。返回 {decision:'pass'|'block', reason, runner, failing?, fresh?, messages[], tail?}
 *  副作用（状态转移）与全局版一致：立基线/清基线/绿史/清脏标记。 */
export function runGate(projectRoot, { skipDirtyCheck = false, force = false } = {}) {
  const st = stateFor(projectRoot)
  const R = (decision, reason, extra = {}) => ({ decision, reason, ...extra })
  const clearMarker = () => { try { fs.unlinkSync(st.markerPath) } catch {} }

  if (!force && !fs.existsSync(st.markerPath)) return R('pass', 'clean-turn')
  const plan = detect(projectRoot)
  if (!plan) { clearMarker(); return R('pass', 'no-test-stack') }
  log(st, `${force ? 'RUN' : 'STOP'} 门禁启动 runner=${plan.runner} root=${projectRoot}`)

  for (const b of plan.build || []) {
    const r = runStep(projectRoot, b)
    if (r.error) { log(st, `构建器不可用(${b.cmd}): ${r.error.message} — 放行`); return R('pass', 'build-tool-missing', { runner: plan.runner }) }
    if (r.status !== 0) {
      if (!loadBaseline(st)) { log(st, '基线未建立即构建失败 — 首放并记录'); return R('pass', 'first-build-fail', { runner: plan.runner }) }
      log(st, '构建失败 — 打回')
      clearMarker()
      return R('block', 'build-failed', { runner: plan.runner, tail: ((r.stderr || '') + (r.stdout || '')).slice(-3000) })
    }
  }

  // 读取本回合脏文件（供 TIA 选择性跑测 + 改动面分类）
  const dirtyFiles = (() => {
    try { return [...new Set(fs.readFileSync(st.markerPath, 'utf8').trim().split('\n').filter(Boolean))] } catch { return [] }
  })()

  // TIA：pytest/go 能把脏文件映射到测试目标；映射不全 → 安全侧全量（只多跑不漏跑）
  let testStep = plan.test
  const selected = plan.select ? plan.select(projectRoot, dirtyFiles) : null
  if (selected && selected.args) {
    testStep = { ...plan.test, args: selected.args }
    log(st, `TIA 选择跑测：${selected.note}`)
  }

  const t = runStep(projectRoot, testStep)
  if (t.error) { log(st, `测试命令不可用(${plan.test.cmd}): ${t.error.message} — 放行`); return R('pass', 'test-tool-missing', { runner: plan.runner }) }
  let out = (t.stdout || '') + (t.stderr || '')
  let names = plan.parse ? plan.parse(out) : []
  const q = loadQuarantine(st)

  // 全绿：清脏/清基线/立绿史 + 隔离区绿连续计数回炉
  if (t.status === 0) {
    clearMarker()
    const had = fs.existsSync(st.baselinePath)
    if (had) { try { fs.unlinkSync(st.baselinePath) } catch {} }
    fs.mkdirSync(st.stateDir, { recursive: true })
    fs.writeFileSync(st.everGreenPath, new Date().toISOString())
    let reintegrated = []
    let qChanged = false
    for (const name of Object.keys(q)) {
      if (!q[name].quarantinedAt) continue
      q[name].greenStreak = (q[name].greenStreak || 0) + 1
      qChanged = true
      if (q[name].greenStreak >= REINTEGRATE_GREEN_STREAK) { delete q[name]; reintegrated.push(name) }
    }
    if (qChanged) saveQuarantine(st, q)
    log(st, had ? '全绿 — 基线自动清除，绿史已立' : '全绿 — 脏标记已清，绿史已立')
    return R('pass', 'green', { runner: plan.runner, reintegrated,
      messages: [had ? '全绿，基线已自动清除，门禁收紧为一红即拦' : '全绿', ...reintegrated.map(n => `抖动测试 ${n} 连续 ${REINTEGRATE_GREEN_STREAK} 绿，已回炉主集`)] })
  }

  const outSig = sig(out)
  const base = loadBaseline(st)
  if (!base) {
    if (fs.existsSync(st.everGreenPath)) {
      log(st, '有绿史且现红 — 回归，打回')
      return R('block', 'regression-after-green', { runner: plan.runner, failing: names,
        messages: ['本仓库曾全绿，现失败（回归）。TEST_GATE_RESET=1 或 reset 工具可重新宽容'],
        tail: out.slice(-3000) })
    }
    saveBaseline(st, projectRoot, names, outSig)
    clearMarker()
    log(st, `基线登记：${names.length} 个已知失败 — 首放`)
    return R('pass', 'baseline-created', { runner: plan.runner, failing: names,
      messages: [`已建立基线：${names.length} 个既有失败记为已知，只拦新增`] })
  }

  const known = new Set(base.failing || [])
  const quarantined = new Set(quarantinedNames(q))
  const fresh = names.filter(n => !known.has(n) && !quarantined.has(n))

  // 基线外新增失败 → 先重跑一次甄别抖动（QAPractices 三信号里 hook 场景能做的：确定性复现）
  if (fresh.length) {
    log(st, `新增失败 ${fresh.length} 个 — 重跑一次甄别抖动`)
    const t2 = runStep(projectRoot, testStep)
    if (t2.error) {
      log(st, `重跑无法执行(${t2.error.message}) — 无法甄别，保守打回`)
      return R('block', 'rerun-tool-error', { runner: plan.runner, fresh,
        messages: ['新增失败且重跑无法执行，无法甄别抖动，保守打回'], tail: out.slice(-3000) })
    }
    // 重跑翻绿的判定看"名字消失"而非整体退出码（基线内可能仍有恒红项）
    const still = plan.parse ? plan.parse((t2.stdout || '') + (t2.stderr || '')) : []
    const stillSet = new Set(still)
    const recovered = fresh.filter(n => !stillSet.has(n))   // 重跑中不再失败 = 抖动
    const realFresh = fresh.filter(n => stillSet.has(n))    // 重跑仍红且仍属新增 = 真回归
    for (const n of recovered) {
      q[n] = q[n] || { flakyHits: 0, greenStreak: 0, quarantinedAt: null }
      q[n].flakyHits += 1
      if (q[n].flakyHits >= FLAKY_HITS_TO_QUARANTINE && !q[n].quarantinedAt) q[n].quarantinedAt = new Date().toISOString()
    }
    if (recovered.length) saveQuarantine(st, q)
    if (realFresh.length) {
      log(st, `重跑仍红的新增失败 ${realFresh.length} 个 — 真回归，打回`)
      return R('block', 'new-failures', { runner: plan.runner, failing: still, fresh: realFresh,
        messages: [`新增失败（基线外、重跑仍红）${realFresh.length} 个${recovered.length ? `；另有 ${recovered.length} 个重跑翻绿已记抖动` : ''}`], tail: ((t2.stdout || '') + (t2.stderr || '')).slice(-3000) })
    }
    // 无真回归：按剩余红盘走基线/隔离内放行
    if (recovered.length) {
      clearMarker()
      const nowQ = recovered.filter(n => q[n] && q[n].quarantinedAt)
      log(st, `重跑翻绿 ${recovered.length} 个 — 判抖动放行${nowQ.length ? `（隔离：${nowQ.join(', ')}）` : ''}`)
      return R('pass', 'flaky-rerun-clear', { runner: plan.runner, flaky: recovered, quarantined: nowQ,
        messages: [`重跑翻绿 ${recovered.length} 个，判为抖动放行`, ...nowQ.map(n => `${n} 抖动累计 ${q[n].flakyHits} 次，已隔离登记（连续 ${REINTEGRATE_GREEN_STREAK} 绿自动回炉）`)] })
    }
    out = (t2.stdout || '') + (t2.stderr || ''); names = still
  }

  if (!names.length && base.signature !== outSig) {
    log(st, '红且无法解析用例名、签名变化 — 保守打回')
    return R('block', 'unparsable-changed', { runner: plan.runner, messages: ['测试红，无法解析用例名且输出变化，保守打回'], tail: out.slice(-3000) })
  }
  clearMarker()
  if (!names.length) {
    saveBaseline(st, projectRoot, names, outSig); log(st, '同一红盘签名 — 基线内放行')
    return R('pass', 'same-red-signature', { runner: plan.runner })
  }
  log(st, `失败 ${names.length} 个均在基线/隔离内 — 放行`)
  return R('pass', 'known-failures', { runner: plan.runner, failing: names })
}

export function status(projectRoot) {
  const st = stateFor(projectRoot)
  const plan = detect(projectRoot)
  let dirty = []
  try { dirty = [...new Set(fs.readFileSync(st.markerPath, 'utf8').trim().split('\n').filter(Boolean))] } catch {}
  let baseline = null
  try { baseline = JSON.parse(fs.readFileSync(st.baselinePath, 'utf8')) } catch {}
  let everGreen = null
  try { everGreen = fs.readFileSync(st.everGreenPath, 'utf8').trim() } catch {}
  const q = loadQuarantine(st)
  let logTail = []
  try { logTail = fs.readFileSync(st.logPath, 'utf8').trim().split('\n').slice(-8) } catch {}
  // 改动面分类（联动测试提示）：后端侧与前端侧同轮都命中 → 提示触发 e2e 联动回归（只提示不自动跑）
  const backendHit = dirty.some(f => /^(src|lib|pkg|cmd|server|api|backend)\//i.test(f))
  const frontendHit = dirty.some(f => /^(webui|ui|front|frontend|client|www|static|public)\//i.test(f) || /\.(html|css|vue|jsx|tsx)$/i.test(f))
  return { projectRoot, stateDir: st.stateDir, detectedRunner: plan ? plan.runner : null,
    dirty, baseline: baseline ? { at: baseline.at, count: baseline.count, failing: baseline.failing } : null,
    everGreen, logTail,
    quarantine: Object.keys(q).length ? q : null,
    changeSurface: dirty.length ? { backend: backendHit, frontend: frontendHit, jointE2eSuggested: backendHit && frontendHit } : null }
}

export function reset(projectRoot) {
  const st = stateFor(projectRoot)
  const removed = []
  for (const [f, name] of [[st.baselinePath, 'baseline'], [st.everGreenPath, 'ever-green'], [st.markerPath, 'marker'], [st.quarantinePath, 'quarantine']]) {
    try { fs.unlinkSync(f); removed.push(name) } catch {}
  }
  log(st, 'RESET — 基线/绿史/脏标记/隔离区已清')
  return { removed }
}
