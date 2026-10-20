#!/usr/bin/env node
/**
 * gate-core — 测试门禁共享内核。
 * 被三个薄壳复用：hooks/gate-hook.mjs（事件驱动拦截）、mcp/server.mjs（可查询能力面）、
 * lib/gate-cli.mjs（跨宿主/CI 命令行）。
 *
 * 判定语义：
 *   PostToolUse(Edit|Write 碰 src/tests/manifest) 记脏 → Stop 跑栈；
 *   首红立基线放行 → 只拦新增失败名 → 全绿清基线+立绿史 → 绿史后红=回归直接打回。
 *
 * 三种决策：
 *   pass         — 绿 / 基线内 / 抖动放行 / 未改动；
 *   block        — 新增失败、回归、构建失败（打回）；
 *   unevaluated  — 门禁无法评估（测试器缺失、超时、输出溢出、输出不可解析）。
 *                  hook 对 unevaluated 放行会话（门禁坏了不卡人），但必须显式告警，
 *                  绝不再伪装成 pass——否则"超时/溢出"会被当成"全绿"。
 *
 * 状态目录 %TEMP%\zcode-test-gate\<项目路径哈希>，与全局版共享同一份基线。
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
  for (let i = 0; i < 12; i++) {
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

// ── 测试文件命名空间（规范见 skills/test-namespace/SKILL.md）──
// 两类偏离，各一条警告（均不拦截；TEST_GATE_NS=0 整体关闭）：
//   test-outside-namespace  —— 测试命名的文件写在 tests/ 树外（Go/Rust 惯例除外）
//   test-will-not-be-discovered —— tests/ 树内的代码文件不匹配 runner 发现命名（假绿源头）
//
// 关键：路径不能区分"测试文件"与"放在 tests/ 下的普通项目文件"（setup/mocks/factories/
// helpers 都是合法非测试文件）。因此必须看**内容**——只有真的含测试声明才判定为测试，
// 否则一律放行，避免把正常项目文件误报成命名违规。
const NS_ROOT = /^(tests?|spec|__tests__)\//i
const NS_EXEMPT = /^(tests?|spec|__tests__)\/(harness|testdata|fixtures|mocks|__mocks__|factories|__fixtures__)\//i
const NS_TEST_JS = /\.(test|spec)\.[cm]?[jt]sx?$/i
const NS_TEST_PY = /^test_.*\.py$|_test\.py$/i
const NS_TEST_GO = /_test\.go$/i          // Go 惯例：与源码同目录，不算偏离
const NS_TEST_CS = /Tests\.cs$/i
const NS_TEST_CPP = /_?tests?\.(cpp|cc|cxx)$/i
const NS_IMPL = /\.(m|c|cc|cpp|cxx|h|hpp|py|js|mjs|cjs|ts|tsx|jsx|go|cs|java|kt|rb|php|swift|scala)$/i
// pytest 约定文件：在 tests/ 树内但不是用例，不算命名偏离
const NS_PY_SPECIAL = /^(conftest\.py|__init__\.py|pytest\.ini)$/i

// 测试声明特征（按语言）。只认"定义了一条测试"的构造，不认 assert/expect 的单纯 import，
// 否则把用断言库的普通模块也误判成测试。
const TEST_SIGNATURES = {
  js: /(^|[^.\w])(test|it|describe|suite)(\.(only|skip|each|concurrent))?\s*\(/m,
  py: /^\s*(def\s+test_\w+|class\s+Test\w*)/m,
  go: /^func\s+(Test|Benchmark|Fuzz)\w*\s*\(/m,
  cs: /^\s*\[(Test|Fact|Theory|TestMethod|TestCase)\b/m,
  cpp: /^\s*(TEST|TEST_F|TEST_P|TYPED_TEST|BOOST_AUTO_TEST_CASE)\s*\(/m,
  rs: /#\[(test|tokio::test)\]/,
  java: /^\s*@(Test|ParameterizedTest|RepeatedTest)\b/m,
}
function looksLikeTestContent(text, base) {
  if (!text) return false
  const sample = text.slice(0, 65536)          // 只看前 64KB，避免大文件开销
  if (/\.(py)$/i.test(base)) return TEST_SIGNATURES.py.test(sample)
  if (/\.go$/i.test(base)) return TEST_SIGNATURES.go.test(sample)
  if (/\.cs$/i.test(base)) return TEST_SIGNATURES.cs.test(sample)
  if (/\.(cpp|cc|cxx)$/i.test(base)) return TEST_SIGNATURES.cpp.test(sample)
  if (/\.rs$/i.test(base)) return TEST_SIGNATURES.rs.test(sample)
  if (/\.(java|kt)$/i.test(base)) return TEST_SIGNATURES.java.test(sample)
  return TEST_SIGNATURES.js.test(sample)
}

/**
 * @param {string} rel 项目内相对路径
 * @param {{content?:string}} [opts] 文件内容。提供时做内容判定（准确）；
 *   省略时仅对"文件名本身已强烈表明是测试"的路径告警，其余一律放行（宁可漏报不误报）。
 */
export function checkNamespace(rel, opts = {}) {
  if (process.env.TEST_GATE_NS === '0') return null
  const r = rel.replace(/\\/g, '/')
  if (/(^|\/)(vendor|node_modules|dist|build|coverage)\//.test(r)) return null
  const base = r.split('/').pop() || ''
  if (NS_PY_SPECIAL.test(base)) return null
  if (NS_TEST_GO.test(base)) return null                    // Go 同位置惯例
  if (/\.rs$/i.test(base)) return null                       // Rust：src 内 #[cfg(test)] 与 tests/*.rs 都是正典

  const namedTest = NS_TEST_JS.test(base) || NS_TEST_PY.test(base) || NS_TEST_CS.test(base) || NS_TEST_CPP.test(base)
  const hasContent = typeof opts.content === 'string'
  // 内容可用时以内容为准；否则只用"命名已明确"这一强信号，不做 tests/ 树内的猜测
  const isTest = hasContent ? looksLikeTestContent(opts.content, base) : namedTest

  if (namedTest && !NS_ROOT.test(r) && isTest) {
    return { code: 'test-outside-namespace', file: r,
      msg: `测试文件在 tests/ 命名空间之外：${r}（Go/Rust 同位置惯例除外）`,
      fix: '按 test-namespace 技能（e2e-suite:test-namespace）放置：移到 tests/<层级>/，层级选 unit/api/e2e/ui' }
  }
  if (NS_ROOT.test(r) && !NS_EXEMPT.test(r) && !namedTest && isTest) {
    return { code: 'test-will-not-be-discovered', file: r,
      msg: `tests/ 树内的文件含测试声明但命名不匹配 runner 发现规则：${r}——它永远不会被执行（假绿）`,
      fix: '按 test-namespace 技能改名：JS 用 *.test.*、Python 用 test_*.py；若它不是测试（mock/工厂/辅助），移到 tests/mocks、tests/factories 或 tests/harness/' }
  }
  return null
}

// 读文件内容供内容判定（读不到返回 null → 调用方退回路径判定）
function readSample(abs) {
  try {
    const st = fs.statSync(abs)
    if (!st.isFile() || st.size > 2 * 1024 * 1024) return null
    return fs.readFileSync(abs, 'utf8')
  } catch { return null }
}

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
  const abs = path.resolve(projectRoot, filePath)
  const rel = path.relative(projectRoot, abs).replace(/\\/g, '/')
  // 跨盘符时 path.relative 返回绝对路径（不以 .. 开头），必须显式排除，否则项目外改动也会触发跑测
  const inside = !path.isAbsolute(rel) && !rel.startsWith('..')
  if (inside && isCodePath(rel)) {
    fs.mkdirSync(st.stateDir, { recursive: true })
    fs.appendFileSync(st.markerPath, rel + '\n')
  }
  // 写时命名空间校验：读刚写完的文件内容做判定（路径不足以区分测试与普通文件）
  let nsWarning = null
  if (inside) {
    const content = readSample(abs)
    nsWarning = content === null ? checkNamespace(rel) : checkNamespace(rel, { content })
  }
  return { marked: true, nsWarning }
}

// ── 失败名解析（各运行器输出格式不同，不能共用 jest 的符号行）───────────────
// 统一产出 { name, file? }；name 只取用例标识，剔除耗时/尾注，保证重跑可比较。
const stripAnsi = (s) => s.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')
const cleanName = (s) => s.replace(/\s*\(\d+(?:\.\d+)?\s*(?:ms|s|m|h)\)\s*$/i, '').trim()

function parseJest(out) {
  const names = [...out.matchAll(/^\s*(?:✕|×|✗|✖)\s+(.+)$/gm)].map(m => cleanName(m[1]))
  return names.filter(n => n && !/^failing tests?:?$/i.test(n)).map(n => ({ name: n }))
}
function parsePytest(out) {
  const seen = new Set()
  const rows = []
  for (const m of out.matchAll(/^FAILED\s+(\S+)(?:\s+-\s+(.*))?$/gm)) {
    const file = m[1]
    const name = m[2] ? `${file} - ${m[2]}` : file
    if (!seen.has(name)) { seen.add(name); rows.push({ name, file }) }
  }
  return rows
}
function parseCargo(out) {
  return [...out.matchAll(/^\s*test\s+(\S+)\s+\.\.\.\s+FAILED/gm)].map(m => ({ name: m[1] }))
}
function parseGo(out) {
  return [...out.matchAll(/--- FAIL:\s+(\S+)/g)].map(m => ({ name: m[1] }))
}
function parseDotnet(out) {
  return [...out.matchAll(/^\s*Failed\s+(\S+)/gim)].map(m => ({ name: m[1] }))
}
function parseUnitTests(out) {
  return [...out.matchAll(/^\[FAIL\]\s+(\S+)/gm)].map(m => ({ name: m[1] }))
}
// node --test（spec reporter）：`✖ alpha fails (1.82ms)` + 汇总 `failing tests:` 伪行
function parseNodeTest(out) {
  const names = [...out.matchAll(/^\s*[✖✗✕×]\s+(.+?)\s*$/gm)].map(m => cleanName(m[1]))
  return names.filter(n => n && !/^(failing tests?:?|test[s]? failed|failing)$/i.test(n)).map(n => ({ name: n }))
}
// vitest：`FAIL  src/a.test.ts > suite > case`；`× case` 行在部分 reporter 出现
function parseVitest(out) {
  const rows = []
  const seen = new Set()
  for (const m of out.matchAll(/^\s*FAIL\s+(\S+)\s+>\s+(.+)$/gm)) {
    const name = `${m[1]} > ${m[2].trim()}`
    if (!seen.has(name)) { seen.add(name); rows.push({ name, file: m[1] }) }
  }
  if (rows.length) return rows
  return [...out.matchAll(/^\s*(?:×|✕)\s+(.+)$/gm)].map(m => ({ name: cleanName(m[1]) }))
}
// mocha：`  1) suite` + `  case:`；以及 `failing` 段的编号块。取最常见的缩进失败行
function parseMocha(out) {
  const rows = []
  const seen = new Set()
  for (const m of out.matchAll(/^\s{2,}\d+\)\s+(.+)$/gm)) {
    const name = cleanName(m[1])
    if (name && !seen.has(name)) { seen.add(name); rows.push({ name }) }
  }
  return rows
}
// 通用兜底：FAIL/FAILED/✕ 前缀行，仍解析不出就返回空（由签名比对兜底）
function parseGeneric(out) {
  const rows = []
  const seen = new Set()
  for (const m of out.matchAll(/^\s*(?:FAIL(?:ED)?|✕|✖|×)\s+(\S.*)$/gm)) {
    const name = cleanName(m[1])
    if (name && !seen.has(name)) { seen.add(name); rows.push({ name }) }
  }
  return rows
}

function testCount(out) {
  const m = out.match(/(\d+)\s+failed/i)
  return m ? +m[1] : null
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
    const script = pkg.scripts && typeof pkg.scripts.test === 'string' ? pkg.scripts.test : ''
    if (script && !/no tests? configured|no test specified|placeholder/i.test(script)) {
      // 按 test 脚本实际使用的运行器选解析器（原先一律套 jest，导致 node --test/vitest/mocha 全部失效）
      let runner = 'generic'
      if (/\bnode\s+--test\b|\bnode\s+-t\b/.test(script)) runner = 'node-test'
      else if (/\bjest\b/.test(script)) runner = 'jest'
      else if (/\bvitest\b/.test(script)) runner = 'vitest'
      else if (/\bmocha\b/.test(script)) runner = 'mocha'
      else if (has('jest.config.js') || has('jest.config.ts') || has('jest.config.cjs') || pkg.jest) runner = 'jest'
      else if (has('vitest.config.js') || has('vitest.config.ts') || has('vitest.config.mjs')) runner = 'vitest'
      else if (has('.mocharc.json') || has('.mocharc.js') || has('.mocharc.yml')) runner = 'mocha'
      const parser = { 'node-test': parseNodeTest, jest: parseJest, vitest: parseVitest, mocha: parseMocha, generic: parseGeneric }[runner]
      return {
        runner,
        test: { cmd: pm, args: pm === 'npm' ? ['test', '--silent'] : ['run', 'test'] },
        parse: (o) => parser(stripAnsi(o)),
        failCount: testCount,
      }
    }
  }
  if (/(^\s*pytest|python_requires.*pytest|\bpytest\b)/m.test(read('pyproject.toml')) || /\bpytest\b/.test(read('requirements.txt'))
      || has('pytest.ini') || has('tox.ini') || (has('setup.cfg') && /pytest/.test(read('setup.cfg')))) {
    let hasTests = has('tests')
    try { hasTests = hasTests || fs.readdirSync(projectRoot).some(f => f.startsWith('test_') && f.endsWith('.py')) } catch {}
    if (hasTests) {
      return { runner: 'pytest', test: { cmd: 'python', args: ['-m', 'pytest', '-q', '--no-header', '-rf'] },
        select: selectPytest(projectRoot),
        parse: (o) => parsePytest(stripAnsi(o)),
        failCount: testCount }
    }
  }
  if (has('Cargo.toml')) return { runner: 'cargo', test: { cmd: 'cargo', args: ['test'] },
    parse: (o) => parseCargo(stripAnsi(o)), failCount: testCount }
  if (has('go.mod')) return { runner: 'gotest', test: { cmd: 'go', args: ['test', './...'] },
    select: selectGo(projectRoot),
    parse: (o) => parseGo(stripAnsi(o)), failCount: testCount }
  const sln = lsSafe(projectRoot).find(f => f.endsWith('.sln'))
  if (sln) return { runner: 'dotnet', test: { cmd: 'dotnet', args: ['test', sln, '--nologo', '-v', 'q'] },
    parse: (o) => parseDotnet(stripAnsi(o)), failCount: testCount }
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
        parse: (o) => parseUnitTests(stripAnsi(o)), failCount: testCount }
    }
  }
  const mk = read('Makefile') || read('makefile')
  if (/^test\s*:/m.test(mk)) return { runner: 'make', test: { cmd: 'make', args: ['test'] },
    parse: (o) => parseGeneric(stripAnsi(o)), failCount: testCount }
  return null
}

// ── TIA 影响面选择（Datadog/mabl 口径：只跑受影响；映射不全 → 安全侧全量，只多跑不漏跑）──
// 脏文件为空 → 返回 null（调用方退回全量）。映射失败/共享面命中 → null（全量）。
function selectPytest(projectRoot) {
  // 递归收集 tests/ 树下的测试文件（支持 tests/unit/、tests/api/ 等分层命名空间）
  const testIndex = (() => {
    const index = new Map()   // test_<module>.py 文件名 → 相对路径
    const walk = (dir, depth) => {
      if (depth > 6) return
      let entries = []
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        if (e.name === 'node_modules' || e.name === '.git' || e.name === '__pycache__') continue
        const full = path.join(dir, e.name)
        if (e.isDirectory()) { walk(full, depth + 1); continue }
        if (!/^(test_.*|.*_test)\.py$/.test(e.name)) continue
        const rel = path.relative(projectRoot, full).replace(/\\/g, '/')
        if (!index.has(e.name)) index.set(e.name, rel)
      }
    }
    for (const d of ['tests', 'test']) walk(path.join(projectRoot, d), 0)
    return index
  })()

  return (_root, dirtyFiles) => {
    if (!dirtyFiles || !dirtyFiles.length) return null
    const targets = new Set()
    const testDirs = ['tests', 'test']
    for (const f of dirtyFiles) {
      const base = f.split('/').pop() || ''
      // 测试文件本身直接进目标
      if (/^(test_.*|.*_test)\.py$/.test(base) || /\.py$/.test(base) && testDirs.includes(f.split('/')[0])) { targets.add(f); continue }
      // 源文件 → 同名测试（test_<module>.py / <module>_test.py，任意层级）；找不到 → 全量兜底
      if (/\.py$/.test(base)) {
        const stem = base.replace(/\.py$/, '')
        const found = testIndex.get(`test_${stem}.py`) || testIndex.get(`${stem}_test.py`)
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

// ── 基线 ────────────────────────────────────────────────────────────────
// 字段：failing（归一化失败名）、count、partial（是否由 TIA 子集跑测建立）、scope（子集目标）、
//       failedCount（测试器报告的失败数，用于识别"解析不全"）、signature（输出签名）。
function loadBaseline(st) { try { return JSON.parse(fs.readFileSync(st.baselinePath, 'utf8')) } catch { return null } }
function saveBaseline(st, projectRoot, extra) {
  fs.mkdirSync(st.stateDir, { recursive: true })
  fs.writeFileSync(st.baselinePath, JSON.stringify({
    at: new Date().toISOString(), project: projectRoot,
    failing: extra.failing || [], count: (extra.failing || []).length,
    partial: !!extra.partial, scope: extra.scope || null,
    buildOnly: !!extra.buildOnly,
    failedCount: extra.failedCount ?? null, signature: extra.signature || null,
  }, null, 2))
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
  const opts = {
    cwd: projectRoot, timeout: s.timeout || 300_000, encoding: 'utf8', windowsHide: true,
    // 测试输出可能很大（失败堆栈/verbose reporter）；默认 1MB 会 ENOBUFS，被误判成"工具缺失"
    maxBuffer: 64 * 1024 * 1024,
  }
  if (isCmdShell) {
    const args = (s.args || []).map(a => /\s/.test(a) ? JSON.stringify(a) : a)
    return spawnSync([s.cmd, ...args].join(' '), { ...opts, shell: true })
  }
  return spawnSync(s.cmd, s.args || [], opts)
}

// spawnSync 的 error 覆盖 ENOENT/ETIMEDOUT/ENOBUFS/EACCES——只有 ENOENT 才是"工具没装"
function spawnFailure(r) {
  if (!r.error) return null
  const code = r.error.code || ''
  if (code === 'ENOENT') return { kind: 'tool-missing', message: `命令不存在（${code}）` }
  if (code === 'ETIMEDOUT') return { kind: 'timeout', message: '执行超时' }
  if (code === 'ENOBUFS') return { kind: 'output-overflow', message: '输出超出缓冲上限' }
  return { kind: 'spawn-error', message: `${code || 'unknown'}: ${r.error.message || r.error}` }
}

/** 完整门禁判定。返回 { decision:'pass'|'block'|'unevaluated', reason, runner, failing?, fresh?, messages[], tail? }
 *  副作用（状态转移）：立基线/清基线/绿史/清脏标记。
 *  @param {{force?:boolean, skipDirtyCheck?:boolean}} opts  force=忽略脏标记直接跑；
 *         skipDirtyCheck=true 时即使有脏标记也当作"没改过"跳过（供外部显式调度）。 */
export function runGate(projectRoot, { skipDirtyCheck = false, force = false } = {}) {
  const st = stateFor(projectRoot)
  let nsWarnings = []
  const R = (decision, reason, extra = {}) => ({
    decision, reason, ...extra,
    // 命名空间警告随所有判定结果返回（去重、不拦截；TEST_GATE_NS=0 时为空）
    ...(nsWarnings.length ? { nsWarnings } : {}),
  })
  const clearMarker = () => { try { fs.unlinkSync(st.markerPath) } catch {} }
  const keepMarker = () => { /* unevaluated：保留脏标记，下回合继续尝试把关 */ }

  if (skipDirtyCheck) return R('pass', 'skip-dirty-check')
  if (!force && !fs.existsSync(st.markerPath)) return R('pass', 'clean-turn')
  const plan = detect(projectRoot)
  if (!plan) { clearMarker(); return R('pass', 'no-test-stack') }
  log(st, `${force ? 'RUN' : 'STOP'} 门禁启动 runner=${plan.runner} root=${projectRoot}`)

  for (const b of plan.build || []) {
    const r = runStep(projectRoot, b)
    const fail = spawnFailure(r)
    if (fail) {
      log(st, `构建器不可用(${b.cmd}): ${fail.message} — unevaluated`)
      return R('unevaluated', 'build-tool-missing', { runner: plan.runner,
        messages: [`构建器不可用（${fail.message}），本次无法评估测试状态`] })
    }
    if (r.status !== 0) {
      const base0 = loadBaseline(st)
      const tail = ((r.stderr || '') + (r.stdout || '')).slice(-3000)
      // 首红登记、之后打回——与测试基线同一生命周期。原实现"首放"但从不登记，
      // 导致构建永远失败的项目每回合都命中"首次"分支、永久放行。
      if (!base0) {
        saveBaseline(st, projectRoot, { failing: [], buildOnly: true, signature: sig(String(r.status)) })
        clearMarker()
        log(st, '构建失败（首红）— 登记构建基线并放行一次，后续构建失败将打回')
        return R('pass', 'build-failed-first', { runner: plan.runner,
          messages: ['构建失败（首次）已登记为已知状态；再次构建失败将打回，修复后基线自动清除'],
          tail })
      }
      log(st, '构建失败 — 打回')
      clearMarker()
      return R('block', 'build-failed', { runner: plan.runner, tail })
    }
  }
  // 构建成功：构建基线作废（否则测试红会被当成"新增"而无法建立测试基线）
  if (loadBaseline(st)?.buildOnly) {
    try { fs.unlinkSync(st.baselinePath) } catch {}
  }

  // 读取本回合脏文件（供 TIA 选择性跑测 + 改动面分类 + 命名空间汇总）
  const dirtyFiles = (() => {
    try { return [...new Set(fs.readFileSync(st.markerPath, 'utf8').trim().split('\n').filter(Boolean))] } catch { return [] }
  })()
  nsWarnings = [...new Set(dirtyFiles.map(f => {
    const content = readSample(path.join(projectRoot, f))
    return content === null ? checkNamespace(f) : checkNamespace(f, { content })
  }).filter(Boolean))]
  if (nsWarnings.length) log(st, `命名空间警告 ${nsWarnings.length} 条：${nsWarnings.map(w => w.code).join(',')}`)

  // TIA：pytest/go 能把脏文件映射到测试目标；映射不全 → 安全侧全量（只多跑不漏跑）
  let testStep = plan.test
  let selection = null
  const selected = plan.select ? plan.select(projectRoot, dirtyFiles) : null
  if (selected && selected.args) {
    testStep = { ...plan.test, args: selected.args }
    selection = selected
    log(st, `TIA 选择跑测：${selected.note}`)
  }

  const t = runStep(projectRoot, testStep)
  const tFail = spawnFailure(t)
  if (tFail) {
    log(st, `测试命令不可用(${plan.test.cmd}): ${tFail.message} — unevaluated`)
    return R('unevaluated', 'test-tool-missing', { runner: plan.runner,
      messages: [`测试命令不可用（${tFail.message}），本次无法评估测试状态`] })
  }
  const out = (t.stdout || '') + (t.stderr || '')
  const parsed = plan.parse ? plan.parse(out) : []
  const names = parsed.map(x => x.name)
  const failedCount = plan.failCount ? plan.failCount(out) : null
  // 解析不全（有失败数但名字数对不上）→ 不能拿不完整的名字集做基线比对
  const parseIncomplete = failedCount !== null && failedCount > names.length
  const q = loadQuarantine(st)

  // 全绿
  if (t.status === 0) {
    clearMarker()
    // TIA 子集绿 ≠ 全量绿：未跑的用例状态未知，基线一律不动、也不写绿史。
    // （子集覆盖范围无法从失败名单反推——基线项可能恰好落在未跑的用例里。）
    if (selection) {
      const kept = (loadBaseline(st)?.failing || []).length
      log(st, `TIA 子集全绿（${selection.note}）— 基线保留 ${kept} 项，不写绿史`)
      return R('pass', 'subset-green', { runner: plan.runner,
        messages: [`子集跑测全绿（${selection.note}）；基线保留 ${kept} 项，未建立绿史（全量绿才收紧门禁）`] })
    }
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

  // 红但名字解析不全：签名兜底；仍无法确认 → unevaluated（不伪装成绿）
  if (!names.length || parseIncomplete) {
    const outSig = sig(out.replace(/\s+/g, ' ').trim())
    const base0 = loadBaseline(st)
    if (base0 && base0.signature === outSig) {
      clearMarker()
      log(st, '同一红盘签名 — 基线内放行')
      return R('pass', 'same-red-signature', { runner: plan.runner })
    }
    if (!base0 && fs.existsSync(st.everGreenPath)) {
      log(st, '有绿史且现红但无法解析用例名 — 回归，打回')
      return R('block', 'regression-after-green', { runner: plan.runner, failing: [],
        messages: ['本仓库曾全绿，现失败且无法解析用例名（回归）。TEST_GATE_RESET=1 或 reset 工具可重新宽容'],
        tail: out.slice(-3000) })
    }
    if (!base0) {
      saveBaseline(st, projectRoot, { failing: [], signature: outSig, failedCount, parseIncomplete })
      clearMarker()
      log(st, `基线登记（无可用失败名，记录输出签名；failedCount=${failedCount}）— 首放`)
      return R('pass', 'baseline-created-unparsed', { runner: plan.runner,
        messages: [`测试红但无法解析用例名（报告 ${failedCount ?? '?'} 个失败），已按输出签名登记基线；修复前输出变化即打回`] })
    }
    log(st, '红且无法解析用例名、签名变化 — unevaluated（保守不放行也不伪装绿）')
    return R('unevaluated', 'unparsable-changed', { runner: plan.runner,
      messages: ['测试红且无法解析用例名，输出与基线不一致，无法判定新增/既有失败'],
      tail: out.slice(-3000) })
  }

  const outSig = sig(out.replace(/\s+/g, ' ').trim())
  const base = loadBaseline(st)
  if (!base) {
    if (fs.existsSync(st.everGreenPath)) {
      log(st, '有绿史且现红 — 回归，打回')
      return R('block', 'regression-after-green', { runner: plan.runner, failing: names,
        messages: ['本仓库曾全绿，现失败（回归）。TEST_GATE_RESET=1 或 reset 工具可重新宽容'],
        tail: out.slice(-3000) })
    }
    saveBaseline(st, projectRoot, { failing: names, signature: outSig, failedCount, partial: !!selection, scope: selection?.note })
    clearMarker()
    log(st, `基线登记：${names.length} 个已知失败 — 首放${selection ? `（子集：${selection.note}）` : ''}`)
    return R('pass', 'baseline-created', { runner: plan.runner, failing: names,
      messages: [`已建立基线：${names.length} 个既有失败记为已知，只拦新增${selection ? `（注意：本次为子集跑测，基线仅覆盖 ${selection.note}）` : ''}`] })
  }

  const known = new Set(base.failing || [])
  const quarantined = new Set(quarantinedNames(q))
  const fresh = names.filter(n => !known.has(n) && !quarantined.has(n))

  // 基线外新增失败 → 先重跑一次甄别抖动（QAPractices 三信号里 hook 场景能做的：确定性复现）
  if (fresh.length) {
    log(st, `新增失败 ${fresh.length} 个 — 重跑一次甄别抖动`)
    const t2 = runStep(projectRoot, testStep)
    const t2Fail = spawnFailure(t2)
    if (t2Fail) {
      log(st, `重跑无法执行(${t2Fail.message}) — 无法甄别，保守打回`)
      return R('block', 'rerun-tool-error', { runner: plan.runner, fresh,
        messages: ['新增失败且重跑无法执行，无法甄别抖动，保守打回'], tail: out.slice(-3000) })
    }
    const still = plan.parse ? plan.parse((t2.stdout || '') + (t2.stderr || '')).map(x => x.name) : []
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
  }

  clearMarker()
  if (!names.length) {
    saveBaseline(st, projectRoot, { ...base, signature: outSig, failedCount })
    log(st, '同一红盘签名 — 基线内放行')
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
    dirty, baseline: baseline ? {
      at: baseline.at, count: baseline.count, failing: baseline.failing,
      partial: !!baseline.partial, scope: baseline.scope || null,
    } : null,
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
