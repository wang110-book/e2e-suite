---
name: tdd-loop
description: 强制 Red-Green-Refactor 三段 TDD 纪律：用三个互相隔离的子代理分别承担"写失败测试→最小实现→重构"，防止同一上下文里测试围绕已计划的实现来设计。触发短语："实现"、"加功能"、"写个 X 支持"、"build"、"create"等新增行为类请求（用户明确要求走 TDD 时优先触发）。不触发：纯 bug 修复（走缺陷复现测试流程）、文档、配置变更。属于 e2e-suite 技能家族（phase=custom），家族契约见 frontend-backend-e2e 的 references/suite-contract.md。
---

# TDD Loop

抄自 alexop.dev《A Claude Code TDD Skill: Forcing Red-Green-Refactor Discipline》的 tdd-integration 技能结构（相位门与返回契约为原文条款），子代理派发适配 ZCode `Agent` 工具（`subagent_type: general-purpose`）。

## 家族契约（e2e-suite）

- phase: custom
- before: exec（新功能走本技能产出的实现+单测，交给 exec 成员做黑盒回归）
- after: design（只读消费现有用例集，避免重复造卡、对齐编号）
- inputs: 功能需求描述、项目现有测试结构与构建系统、（若有）`test-suite/test-cases-vN.md` 相关卡片
- outputs: 失败测试文件、绿色实现、重构记录、**用例集补充候选**（是否入册由 test-case-design 结算裁决——本成员不写他人产物）
- idempotent: no

## 存在理由（原文结论）

同一上下文窗口里 LLM 无法真正 TDD：测试编写阶段的分析会渗进实现思路，实现阶段的代码探索会污染重构评估；尤其"先写实现再补测试"时，测试会围绕已写好的算法设计，验证的是实现而非需求。三段各起**全新上下文的独立子代理**是唯一解法——测试编写者不知道功能将如何实现，实现者只看得到失败测试。

## Mandatory Workflow

每个新功能必须走完三段。**禁止跳过任何一段。**

### Phase 1: RED — 写失败测试

🔴 派发 `general-purpose` 子代理，提示词包含：
- 功能需求描述与期望行为；**不透露任何实现设想**。
- **测试文件放置**：遵循 [test-namespace 技能](../test-namespace/SKILL.md)——先看项目已有测试树跟着放；没有就建 `tests/<层级>/`（unit/api/e2e/ui），命名按对应语言绑定表（JS `*.test.*`、Python `test_*.py`、Go 同位置 `*_test.go`）。**写在 runner 发现规则之外 = 测试永不执行 = 假绿**。
- 先读项目现有测试学习结构与命名，按其构建系统注册新测试（示例：C++/CMake 项目把 `tests/test_<模块>.cpp` 加进聚合测试目标）。
- 断言完整描述期望行为，含错误分支；AAA 结构；一测一断言优先。
- **禁止写任何实现代码**（实现源目录一个字节都不许碰）。

子代理返回（原文契约）：
- 测试文件路径
- 失败输出，确认测试确实红（**编译通过、断言失败**；拼写/导入/构建错误不算红）
- 该测试验证了什么行为的摘要

**失败未被确认前，不得进入 Green 阶段。**（原文：Do NOT proceed to Green phase until test failure is confirmed.）

### Phase 2: GREEN — 让测试通过

🟢 派发**全新的** `general-purpose` 子代理（不带 Phase 1 讨论史），输入 = 测试文件路径 + 功能需求：
- 写**最小**实现使全部新断言通过。
- **测试文件冻结**：只许改实现侧；若认为测试有误，停下报告，不许改断言/删用例/加 skip（AGENTS.md 冻结条款）。
- 返回：修改的文件、绿色证据（构建+测试全过的实际输出）、实现摘要。

**测试未全绿前，不得进入 Refactor 阶段。**（原文：Do NOT proceed to Refactor phase until test passes.）

### Phase 3: REFACTOR

派发第三个子代理：保持全绿前提下改善可读性/去重/命名；每步重构后重跑测试；返回 diff 摘要 + 绿色证据。

## 编排规则（总控 = 主会话）

- 主会话只做相位门核对：红/绿证据真实存在、子代理未越文件白名单（RED 没碰实现侧、GREEN 没碰测试侧），不亲自写三段的代码——否则上下文隔离失效。
- 相位门不过 → 打回对应子代理重做，不带病推进。
- 若项目装有测试门禁 hook（如 test-gate 的 Stop 全量把关），本技能与 hook 互为双保险：技能管"顺序与隔离"，hook 管"别忘了跑"。
- 收尾时把新增行为整理成**用例集补充候选**交给用户/结算环节，不代写 `test-cases-vN.md`。
