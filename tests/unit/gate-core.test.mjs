// tests/unit/gate-core.test.mjs — 门禁内核的回归测试（node --test，零依赖）
//
// 每条用例对应一个曾经的真实缺陷：首红基线、TIA 子集绿、多运行器解析、
// 超时/输出溢出、构建失败、跨盘符脏标记、partial 基线假回归、断言消息污染失败名。
// 测试用临时项目 + 伪造 runner 输出，不依赖任何真实测试框架。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const REPO = path.join(import.meta.dirname, '..', '..')
const PKG = path.join(REPO, 'e2e-suite')
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

// 注入式假计划：绕过 detect，直接控制 build/test/parse/select（用于状态机测试）
function fakePlan({ build, testScript, parse, select, failCount } = {}) {
  return {
    runner: 'fake',
    ...(build ? { build } : {}),
    test: { cmd: process.execPath, args: ['-e', testScript] },
    parse: parse || (() => []),
    failCount: failCount || (() => null),
    ...(select ? { select } : {}),
  }
}
// 与 node --test / jest 同形的失败行解析（仅测试内用）
const parseCross = (out) => [...out.matchAll(/^\s*[✕✖×]\s+(.+)$/gm)].map(m => ({ name: m[1].trim() }))

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

test('TIA 子集为红且无完整基线时退回全量，不用子集结果立基线', () => {
  const dir = tmpProject({ 'package.json': '{}' })
  let calls = []
  const plan = fakePlan({
    testScript: 'console.log(process.argv.slice(1).join(" "))',
    parse: parseCross,
    select: (_root, dirty) => {
      calls.push('select')
      // 只选 alpha 时输出 alpha 红；全量时 alpha+beta 都红
      return null // 先占位，下面按 dirty 返回
    },
  })
  // 自定义：select 返回只含 alpha 的子集；testScript 根据参数输出
  plan.select = (_root, dirty) => {
    if (!dirty.length) return null
    return { args: ['-e', 'console.log("✕ alpha fails");process.exit(1)'], note: '1 个映射目标' }
  }
  plan.test = { cmd: process.execPath, args: ['-e', 'console.log("✕ alpha fails\\n✕ beta fails");process.exit(1)'] }
  try {
    CORE.markEdit(dir, 'src/a.py')
    const r = CORE.runGate(dir, { plan })
    // 子集红但无基线 → 必须退回全量，基线必须覆盖 alpha + beta
    assert.equal(r.reason, 'baseline-created')
    assert.deepEqual([...r.failing].sort(), ['alpha fails', 'beta fails'], '基线必须来自全量跑测')
    const st = CORE.status(dir)
    assert.equal(st.baseline.partial, false, '不得再建立 partial 基线')
  } finally { cleanup(dir) }
})

test('连续两轮 TIA 命中不同模块，既有红不得被判成新增失败', () => {
  const dir = tmpProject({ 'package.json': '{}' })
  const plan = fakePlan({
    testScript: 'console.log("✕ alpha fails\\n✕ beta fails");process.exit(1)',
    parse: parseCross,
    select: (_root, dirty) => {
      if (dirty.some(f => f.includes('a.py'))) {
        return { args: ['-e', 'console.log("✕ alpha fails");process.exit(1)'], note: 'alpha' }
      }
      if (dirty.some(f => f.includes('b.py'))) {
        return { args: ['-e', 'console.log("✕ beta fails");process.exit(1)'], note: 'beta' }
      }
      return null
    },
  })
  try {
    CORE.markEdit(dir, 'src/a.py')
    const r1 = CORE.runGate(dir, { plan })
    assert.equal(r1.reason, 'baseline-created')
    assert.deepEqual([...r1.failing].sort(), ['alpha fails', 'beta fails'])

    CORE.markEdit(dir, 'src/b.py')
    const r2 = CORE.runGate(dir, { plan })
    assert.equal(r2.decision, 'pass', `既有红不得假回归打回：${r2.reason} ${JSON.stringify(r2.fresh || [])}`)
  } finally { cleanup(dir) }
})

test('测试器缺失返回 unevaluated，不伪装成 pass', () => {
  const dir = tmpProject({
    'package.json': JSON.stringify({ name: 't', version: '1.0.0', scripts: { test: 'node test.js' } }),
    'test.js': 'process.exit(0)',
  })
  try {
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
  const dir = tmpProject({ 'package.json': '{}' })
  const failing = fakePlan({
    build: [{ cmd: process.execPath, args: ['-e', 'process.exit(1)'], timeout: 10_000 }],
    testScript: 'process.exit(0)',
  })
  const ok = fakePlan({
    build: [{ cmd: process.execPath, args: ['-e', 'process.exit(0)'], timeout: 10_000 }],
    testScript: 'process.exit(0)',
  })
  try {
    const r1 = CORE.runGate(dir, { plan: failing, force: true })
    assert.equal(r1.decision, 'pass')
    assert.equal(r1.reason, 'build-failed-first')

    const r2 = CORE.runGate(dir, { plan: failing, force: true })
    assert.equal(r2.decision, 'block', '构建持续失败必须打回')
    assert.equal(r2.reason, 'build-failed')

    const r3 = CORE.runGate(dir, { plan: ok, force: true })
    assert.equal(r3.decision, 'pass')
    assert.equal(r3.reason, 'green', '构建恢复后应清掉构建基线并正常判绿')
    assert.equal(CORE.status(dir).baseline, null)
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

test('不可解析基线遇到可解析输出时，既有红不得被当成新增失败', () => {
  const dir = npmProject('console.log("boom: cannot parse"); process.exit(1)')
  try {
    const r1 = CORE.runGate(dir, { force: true })
    assert.equal(r1.reason, 'baseline-created-unparsed')

    // 输出格式变化（升级 reporter）后可以解析出既有失败
    fs.writeFileSync(path.join(dir, 'test.js'), red(['✕ legacy preexisting failure']))
    const r2 = CORE.runGate(dir, { force: true })
    assert.notEqual(r2.decision, 'block', `既有红被当成新增：${JSON.stringify(r2.fresh || [])}`)
    assert.ok(['unevaluated', 'pass'].includes(r2.decision))
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

test('family：真实仓库发现 19 名成员，canary-bootstrap 在列、e2e-env-setup 不在', () => {
  const members = FAMILY.discoverFamily(REPO)
  const names = members.map(m => m.name)
  assert.equal(names.length, 19, `发现 ${names.length} 个：${names.join(', ')}`)
  assert.ok(names.includes('blackbox-e2e-test'))
  assert.ok(names.includes('gate-preflight'))
  assert.ok(names.includes('canary-bootstrap'),
    'canary-bootstrap 只在正文里引用"暂停"字面量，不得被误判为 detached')
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

test('pytest 失败名不含断言消息（断言值变化不得判成新增失败）', () => {
  const dir = tmpProject({ 'pytest.ini': '[pytest]\n', 'tests/test_a.py': 'def test_a():\n    assert False\n' })
  try {
    const plan = CORE.detect(dir)
    const a = plan.parse('FAILED tests/test_a.py::test_a - assert 1 == 2\n1 failed')
    const b = plan.parse('FAILED tests/test_a.py::test_a - assert 1 == 3\n1 failed')
    assert.equal(a[0].name, b[0].name, `失败名被断言消息污染：${a[0].name} vs ${b[0].name}`)
    assert.equal(a[0].name, 'tests/test_a.py::test_a')
  } finally { cleanup(dir) }
})

test('Bash 等外部写入：无脏标记但 git 工作区变化时不得判 clean-turn', { skip: (() => {
  const r = spawnSync('git', ['--version'], { encoding: 'utf8' })
  return r.status !== 0 ? 'git 不可用' : false
})() }, () => {
  const dir = tmpProject({
    'package.json': JSON.stringify({ name: 't', version: '1.0.0', scripts: { test: 'node test.js' } }),
    'test.js': 'process.exit(0)',
    'src/a.js': 'export const a = 1\n',
  })
  const git = (...args) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args],
    { cwd: dir, encoding: 'utf8' })
  try {
    git('init')
    git('add', '-A')
    git('commit', '-m', 'init')

    // 第一次：建立 git 快照（无改动 → clean-turn）
    const r0 = CORE.runGate(dir, {})
    assert.equal(r0.reason, 'clean-turn')

    // 模拟 Bash/sed 改文件：没有 PostToolUse 脏标记
    fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'export const a = 2\n')
    const r1 = CORE.runGate(dir, {})
    assert.notEqual(r1.reason, 'clean-turn', 'git 工作区已变化，门禁必须实际跑一次')
  } finally { cleanup(dir) }
})

test('gate-hook 收到坏输入时不抛异常、不阻塞会话', () => {
  const hook = path.join(PKG, 'hooks', 'gate-hook.mjs')
  for (const input of ['not json at all', '{"hook_event_name":"Unknown"}', '']) {
    const r = spawnSync(process.execPath, [hook], { input, encoding: 'utf8', timeout: 30_000 })
    assert.equal(r.status, 0, `输入 ${JSON.stringify(input)} 时 hook 退出码 ${r.status}：${r.stderr}`)
  }
})

test('版本号五处一致（不一致则客户端更新不到新版本）', async () => {
  const r = spawnSync(process.execPath, [path.join(REPO, 'tools', 'bump.mjs'), '--check'], {
    cwd: REPO, encoding: 'utf8',
  })
  assert.equal(r.status, 0, `版本号不一致：\n${r.stdout}\n${r.stderr}\n跑 node tools/bump.mjs <version> 统一`)
})
