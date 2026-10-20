---
name: test-namespace
description: 测试文件命名空间规范与放置指南——决定测试文件放哪个目录、叫什么名字、如何确认它真的会被 runner 执行。当你要新建/移动/重命名测试文件，或不确定测试该放 tests/ 还是源码旁、文件该叫 test_*.py 还是 *.test.ts、为什么新写的测试没跑起来时使用。也用于审查现有测试树是否符合规范。Test file namespace conventions: where tests live, how they are named per language, and how to verify they are actually discovered.
---

# 测试文件命名空间（test-namespace）

## 家族契约（e2e-suite）

- phase: design
- before: exec
- inputs: 项目现有测试树结构、被测源文件路径、技术栈
- outputs: 测试文件放置与命名决策（目录层级 + 文件名 + 发现规则核验方法）
- idempotent: yes（纯规范查询，不改任何文件）

> 本技能是 e2e-suite 测试文件放置与命名的**唯一权威**。tdd-loop、harness-scaffold、
> gate-guide、suite-contract 均指向此处。

## 一句话

**测试文件写在 runner 的发现规则之外 = 永远不会执行 = 门禁照常绿 = 假绿。**

命名规范不是为了好看，是为了让测试真的被跑起来。

## 写测试前，按这个顺序决策

1. **先看项目已有的测试树**——已经有 `tests/`、`test/`、`spec/`、`__tests__/` 就跟着它的结构放，不要另起炉灶。
2. **没有测试树**就建 `tests/<层级>/`，层级按被测对象选：
   - `unit/` 纯函数、模块级逻辑，无外部依赖（最快）
   - `api/` 控制面/HTTP 接口，只打 API，不起浏览器
   - `e2e/` 真实服务 + 驱动，端到端流程（慢，里程碑跑）
   - `ui/` 浏览器 GUI 层（最贵）
3. **按语言选命名**（见下表），模块名必须能从被测源文件推导。
4. **共享代码不放测试目录的根**：工具库进 `tests/harness/`，样本数据进 `tests/testdata/` 或 `tests/fixtures/`。这些目录整树豁免命名检查。
5. **写完确认它真的跑了**（见最后一节）。

## 目录命名空间

```
tests/
  unit/        纯函数/模块级
  api/         控制面接口
  e2e/         端到端
  ui/          浏览器 GUI
  harness/     共享能力库（非测试，runner 不发现）
  testdata/    夹具与样本数据（非测试）
  fixtures/    同上（别名）
```

历史目录别名同样被门禁认可：`test/`、`spec/`、`__tests__/`。新文件一律进上面的分层目录。

## 各语言绑定表

| 平台 | 文件命名 | 放在哪 | 谁发现它 |
|---|---|---|---|
| JS / TS | `<module>.test.mjs` / `.test.js` / `.test.ts` / `.test.tsx` | `tests/<层级>/` | node --test、vitest、jest |
| Python | `test_<module>.py`（也接受 `<module>_test.py`） | `tests/<层级>/` | pytest |
| Go | `<module>_test.go` | **与被测源文件同目录**（Go 惯例，唯一例外） | go test |
| Rust | 单测：源文件内 `#[cfg(test)] mod tests`；集成测试：`tests/<module>.rs` | 源文件内 / `tests/` 顶层 | cargo test |
| C++ / CMake | `<module>_test.cpp` | `tests/<层级>/`，**且必须注册进聚合测试目标** | 构建目标（唯一需手动注册） |
| .NET | `<Module>Tests.cs` | 测试项目的 `Tests/` 目录 | dotnet test |
| Java / Kotlin | `<Module>Test.java` / `Test.kt` | `src/test/java/...`（Maven/Gradle 惯例） | JUnit |

**注意 JS 的坑**：`tests/unit/parser.js` 不会被 `node --test` 发现——必须带 `.test.` 或 `.spec.`。这是实测确认的行为，不是配置问题。

## 禁止写法（会静默漏跑）

| 写法 | 为什么错 |
|---|---|
| `tests/unit/parser.js` | JS 缺少 `.test.`，node --test 不收 |
| `tests/helpers.py` 里写 assert | 不是 `test_*`，pytest 不收；应移到 `tests/harness/` |
| `src/foo.test.py` | Python 前缀规则颠倒，不收 |
| `tests/foo_test.cpp` 未注册进构建目标 | C++ 不会被编译进测试可执行文件 |
| 测试放在 `tests/harness/` 里 | 该目录是共享库区，规范上不写用例 |

**允许的例外**：Go 的 `_test.go` 与源码同目录；Rust 的 `#[cfg(test)]` 留在源文件内；`conftest.py`、`__init__.py` 是 pytest 约定文件，不算偏离。

## 写完怎么确认它真的被执行

光看"测试全绿"不够——那条新测试可能根本没被收集。按平台验：

- **JS**：跑 `node --test` 或 `npm test`，输出里能看到**你写的那条用例名**；或先故意让它红一次（断言 `false`），确认变红后再改回。
- **Python**：`pytest --collect-only -q` 能看到文件路径与用例名。
- **Go**：`go test ./... -run <你的用例名> -v` 有输出。
- **C++**：确认构建目标里包含该文件，且可执行文件输出里出现用例名。

**判据是"用例名出现在输出里"，不是"退出码为 0"。**

## 门禁的自动提醒（v1.2.2 起）

- **写文件时**（PostToolUse）：写到规范外，立刻在 stderr 看到 `[test-gate][namespace]`，附修正建议。
- **收工时**（Stop）：判定结果的 `nsWarnings` 带本回合去重清单。
- 两类警告：`test-outside-namespace`（测试文件在 tests/ 树外）、`test-will-not-be-discovered`（tests/ 树内含测试声明但命名不符发现规则）。
- 都不拦截；`TEST_GATE_NS=0` 可关闭。

**门禁只针对测试文件，绝不打扰普通项目代码**。`tests/` 下的 `setup.js`、`mocks/`、`factories/`、
`helpers.js` 这些不是测试的正常文件不会被告警——判定依据是**文件内容里有没有测试声明**
（`test(` / `it(` / `describe(` / `def test_` / `#[test]` / `[Fact]` / `TEST(...)` 等），
而不是只看路径。只有"确实是测试、却放在 runner 发现不了的位置/命名"才提醒。
