---
name: gate-guide
description: 测试门禁（test-gate）使用与恢复指南。当被 [test-gate] 打回、想知道门禁当前状态、想手动触发一次完整门禁、或需要重置基线时使用。Explains the test gate lifecycle, MCP tools, and recovery paths.
---

# 测试门禁指南（gate-guide）

本插件的 hook 会在收工（Stop）时自动把关：碰过 `src/`、`tests/` 或构建清单的回合，必须测试全绿或失败全在基线内才能结束。基线生命周期全自动，**任何情况下都不要靠改测试/删断言来变绿**（AGENTS.md 冻结条款）。

## 三种判定结果

- `pass` — 全绿 / 失败都在基线或隔离区内 / 抖动放行 / 本回合没改代码。
- `block` — 新增失败、回归、构建失败（hook 以 exit 2 打回）。
- `unevaluated` — **门禁无法评估**：测试器没装、执行超时、输出超出缓冲、输出无法解析。此时 hook 放行会话但会打印 `⚠ 本次门禁无法评估`，**不要把它当成绿灯**——需要手动确认测试状态。

## 被 [test-gate] 打回后怎么办

1. 读打回信息里的失败清单：
   - `新增失败（基线外、重跑仍红）` → 你的改动引入了确定性红。**修实现**；若行为变更是有意的（比如并行会话更新了语义），向用户确认后再处理测试。
   - `本仓库曾全绿，现失败（回归）` → 直接当回归修，**不要重置基线**。
2. 若信息里有 `重跑翻绿 … 判为抖动放行` → 该测试被记了一次 flakyHit（不阻塞）。累计 2 次自动进**隔离区**：隔离期内它红不再打回，但会出现在 `test_gate_status` 的 quarantine 里，连续 10 个全绿回合自动回炉主集。抖动测试该修还是要修（隔离是止血不是治疗）。
3. 若信息里有 `原有基线仅覆盖 TIA 子集…已用本次全量结果补全` → 不是新问题：门禁发现基线不完整，已自动用全量结果补全。直接继续即可。
4. 修完再跑一次收工判定即可，无需其他操作。

## 抖动隔离与影响面选择（v0.2 新增，自动，无需配置）

- **抖动隔离**：基线外新增失败时自动重跑一次甄别（确定性复现检验）；翻绿记 flaky、反复翻绿进隔离区。真回归（重跑仍红）照常打回。
- **TIA 影响面选择**：pytest/go 项目会按本回合脏文件映射只跑受影响的测试/包（省 SMR 磁盘 I/O）；映射不可靠时自动退回全量——**安全侧只多跑、不漏跑**。子集跑测全绿时**不清基线、不立绿史**（未跑的用例状态未知）；子集跑测为红且基线不完整时**退回全量**再判定（否则下一轮跑到别的模块，既有红会被误判成新增）；jest/vitest/mocha/node --test/C++ 聚合 exe 暂为全量。
- **按运行器解析失败名**：jest、vitest、mocha、`node --test`、pytest、cargo、go、dotnet、CMake `unit_tests` 各用各的解析器；解析不出的名字剔除耗时后缀后再比较，避免"每次重跑名字都不同 → 永远判抖动"。
- 隔离区在 `test_gate_reset` 时一并清除。

## MCP 工具（主动查询/触发，不等 Stop）

- `test_gate_status` — 只读。检测栈、脏文件、基线、隔离区（quarantine）、**changeSurface 改动面分类**（`jointE2eSuggested=true` 表示本回合前后端双侧都有改动，该做一轮 e2e-suite 联动回归——只提示不自动跑）、日志尾部。
- `test_gate_run` — 立即完整跑一次门禁（构建+测试+抖动/基线判定）。gate-preflight 技能在联动开跑前用的就是它。
- `test_gate_reset` — 清基线+绿史+隔离区+脏标记，回到"首红重新立基线"的宽容态。**只在确实要重新宽容存量红时用**。

## 与 e2e-suite 家族的接合（gate-preflight，env 槽）

前后端联动测试开跑前，总控会自动发现 `gate-preflight` 成员：它调 `test_gate_run` 出"门禁绿了才开联动、unit 红先修便宜层"的环境说明（落盘 `<被测系统>/e2e-artifacts/gate-preflight.md`）。unit 级门禁与联动黑盒各守一层：本插件管"每回合快而便宜"，exec 成员管"里程碑全链路"，两层互不越界（联动绝不进 Stop 钩子）。

## 环境变量逃生口（对用户，非模型）

- `TEST_GATE_SKIP=1` — 单次收工跳过。
- `TEST_GATE_NS=0` — 关闭测试文件命名空间检查。
- `TEST_GATE_GIT_CHECK=0` — 关闭"无脏标记时用 git 工作区兜底"的检测（默认开启：Bash/sed/生成器改的文件不会记脏，靠 git 兜底才不会误判成 clean-turn）。
- 状态目录：`%TEMP%\zcode-test-gate\<项目哈希>\`（gate.log / baseline.json / quarantine.json / ever-green）。

## 测试文件命名空间（v1.2.2 起）

写测试文件时遵循 [test-namespace 技能](../test-namespace/SKILL.md)：`tests/<层级>/`（unit/api/e2e/ui）+ 各语言镜像命名。**写在 runner 发现规则之外的文件永不执行**，门禁会照常绿——这是假绿的头号来源。

门禁在两种时机给出命名空间警告（都不拦截，`TEST_GATE_NS=0` 可关）：

- **写时**（PostToolUse）：你刚把测试写到规范外，立刻在 stderr 看到 `[test-gate][namespace]`；
- **收工**（Stop）：判定结果的 `nsWarnings` 里带本回合去重后的清单。

两类警告：`test-outside-namespace`（测试命名的文件在 tests/ 树外，Go/Rust 同位置惯例除外）、`test-will-not-be-discovered`（tests/ 树内含测试声明但命名不匹配发现规则）。**门禁只检测测试文件**——判定靠读内容有没有测试声明，`tests/` 下的 setup/mocks/factories/helpers 等普通代码不误报。

## 栈检测范围（自动，零配置）

npm/pnpm/yarn/bun（package.json test 脚本，按脚本内容识别 jest/vitest/mocha/node --test）、pytest（+TIA）、cargo、go（+TIA）、dotnet(.sln)、CMake+VS（unit_tests 目标，cmake 路径自动从 CMakeCache 解析）、make（test 目标）。检测不到测试栈 → 放行（本回合无栈可跑）；测试器缺失/超时/输出溢出 → `unevaluated` 并告警（门禁坏了绝不卡会话，但也绝不谎报绿）。
