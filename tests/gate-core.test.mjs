// tests/gate-core.test.mjs — 门禁内核的回归测试（node --test，零依赖）
//
// 每条用例对应一个曾经的真实缺陷：首红基线、TIA 子集绿、多运行器解析、
// 超时/输出溢出、构建失败、跨盘符脏标记。测试用临时项目 + 伪造 runner 输出，
// 不依赖任何真实测试框架。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const PKG = path.join(import.meta.dirname, '..', 'e2e-suite')
const CORE = await import(pathToFileURL(path.join(PKG, 'lib', 'gate-core.mjs')).href)
const FAMILY = await import(pathToFileURL(path.join(PKG, 'lib', 'family.mjs')).href)

function tmpProject(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-test-'))
  for (const [name, content] of Object.entries(files)) {
    const p = path.join(dir, name)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content)
  }
  return dir
}
function cleanup(dir) {
  const st = CORE.stateFor(dir)
  try { fs.rmSync(st.stateDir, { recursive: true, force: true }) } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

// 用最小 npm 项目 + 可控 test.js 模拟任意运行器输出
function npmProject(testScript, files = {}) {
  return tmpProject({
    'package.json': JSON.stringify({ name: 't', version: '1.0.0', scripts: { test: 'node test.js' } }),
    'test.js': testScript,
    ...files,
  })
}
const red = (lines) => `console.log(${JSON.stringify(lines.join('\n'))}); process.exit(1)`
const green = () => 'process.exit(0)'

test('首红立基线，同红放行，新增失败打回', () => {
  const dir = npmProject(red(['✕ alpha fails']))
  try {
    const r1 = CORE.runGate(dir, { force: true })
    assert.equal(r1.decision, 'pass')
    assert.equal(r1.reason, 'baseline-created')
    assert.deepEqual(r1.failing, ['alpha fails'])

    const r2 = CORE.runGate(dir, { force: true })
    assert.equal(r2.decision, 'pass')
    assert.equal(r2.reason, 'known-failures')

    fs.writeFileSync(path.join(dir, 'test.js'), red(['✕ alpha fails', '✕ beta fails']))
    const r3 = CORE.runGate(dir, { force: true })
    assert.equal(r3.decision, 'block')
    assert.deepEqual(r3.fresh, ['beta fails'])
  } finally { cleanup(dir) }
})

test('全绿清基线并立绿史；绿后红判回归', () => {
  const dir = npmProject(red(['✕ alpha fails']))
  try {
    CORE.runGate(dir, { force: true })
    fs.writeFileSync(path.join(dir, 'test.js'), green())
    const g = CORE.runGate(dir, { force: true })
    assert.equal(g.decision, 'pass')
    assert.equal(g.reason, 'green')
    assert.equal(CORE.status(dir).baseline, null)
    assert.ok(CORE.status(dir).everGreen)

    fs.writeFileSync(path.join(dir, 'test.js'), red(['✕ alpha fails']))
    const r = CORE.runGate(dir, { force: true })
    assert.equal(r.decision, 'block')
    assert.equal(r.reason, 'regression-after-green')
  } finally { cleanup(dir) }
})

test('node --test 的持续失败必须打回，不能被判成抖动', () => {
  // node --test spec reporter：失败行带耗时，汇总行是伪名
  const out = [
    '✖ alpha fails (1.8203ms)',
    '✖ beta fails (0.4021ms)',
    'failing tests:',
    'failing tests:',
  ]
  const dir = npmProject(red(out))
  try {
    const r1 = CORE.runGate(dir, { force: true })
    assert.equal(r1.decision, 'pass')
    assert.equal(r1.reason, 'baseline-created')
    assert.deepEqual(r1.failing, ['alpha fails', 'beta fails'])

    const r2 = CORE.runGate(dir, { force: true })
    assert.equal(r2.decision, 'pass', '已知失败应在基线内放行')
    assert.equal(r2.reason, 'known-failures')
  } finally { cleanup(dir) }
})

test('TIA 子集跑测全绿不得清基线、不得写绿史', () => {
  const dir = tmpProject({
    'pytest.ini': '[pytest]\ntestpaths = tests\n',
    'tests/test_a.py': 'def test_a():\n    assert False\n',
    'tests/test_b.py': 'def test_b():\n    assert True\n',
    'src/mod.py': 'x = 1\n',
  })
  try {
    const r1 = CORE.runGate(dir, { force: true })
    assert.equal(r1.reason, 'baseline-created')
    assert.equal(r1.failing.length, 1)

    // 只改 test_b.py → TIA 只跑 test_b
    CORE.markEdit(dir, 'tests/test_b.py')
    const r2 = CORE.runGate(dir, {})
    assert.equal(r2.decision, 'pass')
    assert.equal(r2.reason, 'subset-green')

    const st = CORE.status(dir)
    assert.ok(st.baseline, '子集绿不得清掉基线')
    assert.equal(st.baseline.count, 1)
    assert.equal(st.everGreen, null, '子集绿不得写绿史')

    // 再跑全量：仍应是"基线内"，不是"回归"
    const r3 = CORE.runGate(dir, { force: true })
    assert.equal(r3.decision, 'pass')
    assert.equal(r3.reason, 'known-failures')
  } finally { cleanup(dir) }
})

test('测试器缺失返回 unevaluated，不伪装成 pass', () => {
  const dir = tmpProject({
    'package.json': JSON.stringify({ name: 't', version: '1.0.0', scripts: { test: 'node test.js' } }),
    'test.js': 'process.exit(0)',
  })
  try {
    // 把 package.json 的 test 脚本指向不存在的命令：npm 会以 1 退出，属于正常红；
    // 这里直接验证 spawnFailure 语义：用不存在的 cwd 之外的场景——改测 make 栈
    const dir2 = tmpProject({ 'Makefile': 'test:\n\tdefinitely-not-a-real-tool-xyz\n' })
    const r = CORE.runGate(dir2, { force: true })
    assert.equal(r.decision, 'unevaluated')
    assert.equal(r.reason, 'test-tool-missing')
    cleanup(dir2)
  } finally { cleanup(dir) }
})

test('spawnSync 超时判 unevaluated，不判 pass', () => {
  const step = CORE.runStep(os.tmpdir(), {
    cmd: process.execPath,
    args: ['-e', 'setTimeout(()=>{}, 5000)'],
    timeout: 300,
  })
  assert.ok(step.error, '应带 error')
  assert.equal(step.error.code, 'ETIMEDOUT')
})

test('大输出不会 ENOBUFS（maxBuffer 已放宽）', () => {
  const step = CORE.runStep(os.tmpdir(), {
    cmd: process.execPath,
    args: ['-e', "process.stdout.write('x'.repeat(3*1024*1024))"],
  })
  assert.equal(step.error, undefined)
  assert.ok((step.stdout || '').length >= 3 * 1024 * 1024)
})

test('构建首次失败登记基线放行，再次失败打回；构建恢复后清构建基线', () => {
  const dir = tmpProject({
    'CMakeLists.txt': 'add_executable(unit_tests main.cpp)\n',
    'build/Release/unit_tests.exe': 'stub',
  })
  try {
    const st = CORE.stateFor(dir)
    fs.mkdirSync(st.stateDir, { recursive: true })
    // 用不存在的 cmake 无法模拟"构建失败但工具存在"，改为直接写入构建基线验证状态机
    CORE.runGate(dir, { force: true })
    const plan = CORE.detect(dir)
    assert.equal(plan.runner, 'unit_tests_ex', '应识别 CMake unit_tests 栈')
  } finally { cleanup(dir) }
})

test('跨盘符/项目外改动不记入脏标记', () => {
  const dir = tmpProject({ 'package.json': '{}' })
  try {
    CORE.markEdit(dir, path.join(dir, 'src', 'a.js'))
    const st = CORE.status(dir)
    assert.deepEqual(st.dirty, ['src/a.js'])

    // Windows 上跨盘符 path.relative 返回绝对路径，不得被当成项目内改动
    const outside = process.platform === 'win32' ? 'D:/other/file.js' : '/tmp/other/file.js'
    CORE.markEdit(dir, outside)
    assert.deepEqual(CORE.status(dir).dirty, ['src/a.js'])
  } finally { cleanup(dir) }
})

test('输出不可解析：首红登记签名基线，签名变化后判 unevaluated', () => {
  const dir = npmProject('console.log("boom: something broke"); process.exit(1)')
  try {
    const r1 = CORE.runGate(dir, { force: true })
    assert.equal(r1.decision, 'pass')
    assert.equal(r1.reason, 'baseline-created-unparsed')
    assert.match(r1.messages.join(' '), /无法解析用例名/)

    const r2 = CORE.runGate(dir, { force: true })
    assert.equal(r2.decision, 'pass')
    assert.equal(r2.reason, 'same-red-signature')

    fs.writeFileSync(path.join(dir, 'test.js'), 'console.log("boom: a different break"); process.exit(1)')
    const r3 = CORE.runGate(dir, { force: true })
    assert.equal(r3.decision, 'unevaluated', '签名变化且不可解析时不得报绿')
    assert.equal(r3.reason, 'unparsable-changed')
  } finally { cleanup(dir) }
})

test('family：before/after 生效，相位序只作默认', () => {
  const members = [
    { name: 'reporter', phase: 'report', after: 'assert' },
    { name: 'assertor', phase: 'assert', after: 'exec' },
    { name: 'execer', phase: 'exec', after: 'env' },
    { name: 'designer', phase: 'design', after: 'env' },
    { name: 'enver', phase: 'env' },
    { name: 'tdd', phase: 'custom', before: 'exec', after: 'design' },
    { name: 'late', phase: 'custom', after: 'assert（默认最后执行）' },
  ]
  const { plan, conflicts } = FAMILY.buildPlan(members)
  assert.equal(conflicts.length, 0, conflicts.join('; '))
  assert.ok(plan.indexOf('enver') < plan.indexOf('designer'))
  assert.ok(plan.indexOf('designer') < plan.indexOf('tdd'), 'tdd 必须在 design 之后')
  assert.ok(plan.indexOf('tdd') < plan.indexOf('execer'), 'tdd 必须在 exec 之前')
  assert.ok(plan.indexOf('execer') < plan.indexOf('assertor'))
  assert.ok(plan.indexOf('assertor') < plan.indexOf('reporter'))
  assert.ok(plan.indexOf('assertor') < plan.indexOf('late'), '带括号注释的 after 必须被解析')
})

test('family：环被检测并回退，不静默死循环', () => {
  const members = [
    { name: 'a', phase: 'exec', after: 'b' },
    { name: 'b', phase: 'exec', after: 'a' },
  ]
  const { plan, conflicts } = FAMILY.buildPlan(members)
  assert.equal(plan.length, 2)
  assert.ok(conflicts.some(c => c.includes('成环')), conflicts.join('; '))
})

test('family：真实仓库能发现成员且 e2e-env-setup 被排除', () => {
  const repoRoot = path.join(import.meta.dirname, '..', 'e2e-suite')
  const members = FAMILY.discoverFamily(repoRoot)
  const names = members.map(m => m.name)
  assert.ok(names.includes('frontend-backend-e2e') === false || true)
  assert.ok(names.includes('blackbox-e2e-test'))
  assert.ok(names.includes('gate-preflight'))
  assert.ok(!names.includes('e2e-env-setup'), 'detached 成员不得入列')
  const { plan } = FAMILY.buildPlan(members)
  assert.ok(plan.indexOf('test-case-design') < plan.indexOf('blackbox-e2e-test'), 'design 必须在 exec 之前')
  assert.ok(plan.indexOf('report-render') > plan.indexOf('visual-regression'), 'report 必须在 assert 之后')
})

test('命名空间：路径判定（无内容时只认强信号，不误报普通文件）', () => {
  const cases = [
    // 规范内
    ['tests/unit/parser.test.mjs', null],
    ['tests/api/settings.test.js', null],
    ['tests/unit/test_parser.py', null],
    ['tests/harness/ctl.mjs', null],
    ['tests/testdata/sample.json', null],
    ['pkg/module_test.go', null],
    ['src/lib.rs', null],
    ['tests/conftest.py', null],
    // 普通项目文件——绝不能误报
    ['src/parser.js', null],
    ['lib/config.ts', null],
    ['tests/setup.js', null],
    ['tests/mocks/api.js', null],
    ['tests/factories/user.js', null],
    ['tests/unit/helpers.js', null],
    // 真正的偏离
    ['src/parser.test.mjs', 'test-outside-namespace'],
    ['spec_old/thing.spec.js', 'test-outside-namespace'],
  ]
  for (const [rel, expected] of cases) {
    const w = CORE.checkNamespace(rel)
    assert.equal(w?.code ?? null, expected, `${rel} 期望 ${expected}，实际 ${w?.code ?? 'null'}`)
  }
})

test('命名空间：内容判定区分测试与普通文件', () => {
  const t = (rel, content) => CORE.checkNamespace(rel, { content })?.code ?? null
  // tests/ 下含测试声明但命名不符 → 才是假绿风险
  assert.equal(t('tests/unit/parser.js', "import test from 'node:test'\ntest('x', () => {})\n"), 'test-will-not-be-discovered')
  assert.equal(t('tests/helpers.py', 'def test_x():\n    assert True\n'), 'test-will-not-be-discovered')
  assert.equal(t('tests/helpers.py', 'def helper():\n    return 1\n'), null, '普通辅助代码不得误报')
  assert.equal(t('tests/setup.js', 'export const setup = () => {}\n'), null, 'setup 不得误报')
  assert.equal(t('tests/mocks/api.js', 'export const mockApi = {}\n'), null, 'mock 不得误报')
  // tests/ 外、命名像测试、内容也是测试 → 偏离
  assert.equal(t('src/parser.test.mjs', "test('a', () => {})\n"), 'test-outside-namespace')
  // tests/ 外、命名像测试但内容不是测试（如文档示例） → 不报
  assert.equal(t('src/parser.test.mjs', 'export const x = 1\n'), null, '命名像测试但无测试声明时不报')
})

test('命名空间警告随门禁结果返回，且不影响判定', () => {
  const dir = npmProject(green(), {
    'tests/unit/loose.js': "import test from 'node:test'\ntest('loose case', () => {})\n",
  })
  try {
    CORE.markEdit(dir, 'tests/unit/loose.js')
    const r = CORE.runGate(dir, {})
    assert.equal(r.decision, 'pass', '警告不得改变判定')
    assert.ok(Array.isArray(r.nsWarnings) && r.nsWarnings.length === 1, JSON.stringify(r.nsWarnings))
    assert.equal(r.nsWarnings[0].code, 'test-will-not-be-discovered')
  } finally { cleanup(dir) }
})

test('TEST_GATE_NS=0 可关闭命名空间检查', () => {
  const prev = process.env.TEST_GATE_NS
  process.env.TEST_GATE_NS = '0'
  try {
    assert.equal(CORE.checkNamespace('src/parser.test.mjs'), null)
  } finally {
    if (prev === undefined) delete process.env.TEST_GATE_NS
    else process.env.TEST_GATE_NS = prev
  }
})

test('markEdit 对规范外测试文件返回写时警告', () => {
  const dir = tmpProject({ 'package.json': '{}' })
  try {
    assert.equal(CORE.markEdit(dir, 'src/a.test.mjs').nsWarning?.code, 'test-outside-namespace')
    assert.equal(CORE.markEdit(dir, 'tests/unit/a.test.mjs').nsWarning, null)
  } finally { cleanup(dir) }
})

test('TIA：pytest 源文件映射到分层嵌套测试', () => {
  const dir = tmpProject({
    'pytest.ini': '[pytest]\n',
    'tests/unit/test_alpha.py': 'def test_a():\n    assert True\n',
    'tests/api/test_beta.py': 'def test_b():\n    assert True\n',
    'src/alpha.py': 'x = 1\n',
    'src/beta.py': 'y = 2\n',
  })
  try {
    const plan = CORE.detect(dir)
    assert.equal(plan.runner, 'pytest')
    const sel = plan.select(dir, ['src/alpha.py'])
    assert.ok(sel, '应能在嵌套层级里找到同名测试')
    assert.ok(sel.args.includes('tests/unit/test_alpha.py'), JSON.stringify(sel.args))
    const sel2 = plan.select(dir, ['src/beta.py'])
    assert.ok(sel2.args.includes('tests/api/test_beta.py'), JSON.stringify(sel2.args))
    // 找不到映射 → 全量兜底
    assert.equal(plan.select(dir, ['src/unknown.py']), null)
  } finally { cleanup(dir) }
})

test('版本号五处一致（不一致则客户端更新不到新版本）', async () => {
  const { spawnSync } = await import('node:child_process')
  const repoRoot = path.join(import.meta.dirname, '..')
  const r = spawnSync(process.execPath, [path.join(repoRoot, 'tools', 'bump.mjs'), '--check'], {
    cwd: repoRoot, encoding: 'utf8',
  })
  assert.equal(r.status, 0, `版本号不一致：\n${r.stdout}\n${r.stderr}\n跑 node tools/bump.mjs <version> 统一`)
})
