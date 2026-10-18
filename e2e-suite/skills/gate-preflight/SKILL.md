---
name: gate-preflight
description: 前后端联动测试开跑前的单元测试门禁体检（e2e-suite 家族 env 槽成员）。读取/触发 test-gate 插件的单元级门禁判定，产出"便宜层是否已绿"的环境说明，联动回归（exec 层黑盒）只在门禁绿后开跑——unit 红先修便宜层，不浪费浏览器与真实节点流量。当总控编排联动测试、或用户要求"先体检门禁""门禁预检""确认单测状态再联调"时使用。E2E-suite env-slot preflight skill。属于 e2e-suite 技能家族（phase=env），家族契约见 frontend-backend-e2e 的 references/suite-contract.md。
---

# 门禁预检（gate-preflight）

## 家族契约（e2e-suite）

- phase: env
- before: design
- inputs: 被测系统仓库路径（有 test-gate 门禁覆盖的）
- outputs: `<被测系统>/e2e-artifacts/gate-preflight.md`（门禁状态说明：runner/基线/隔离区/最近判定/结论）
- idempotent: yes

## 存在理由（业界分层共识）

测试金字塔自底向上执行：unit 红时跑 E2E 是在烧最贵的层验证已坏的便宜层（AWS/QAPractices 分层共识；"每 PR 跑全量 E2E"列为头号反模式）。本成员把 test-gate 的门禁判定接入家族 env 槽：总控 Phase 1 自动发现它，联动计划先过这道闸。

## 流程

1. **体检**：调用本插件的 MCP 工具 `test_gate_run`（强制完整判定一次：构建+跑测+基线/抖动逻辑）。工具在会话中按插件命名空间暴露（形如 `mcp__plugin_e2e-suite_test-gate__test_gate_run`，以 Settings → MCP 实际注册名为准）；不可用时退回读 `%TEMP%\zcode-test-gate\<项目哈希>\` 下 baseline/quarantine/gate.log。
2. **判定分支**：
   - `decision=pass`（全绿 / 基线内 / 抖动放行）→ 结论"**门禁绿，可开联动**"。
   - `decision=block`（新增失败/回归/构建失败）→ 结论"**先修 unit 层**"，把 failing/fresh 清单原样写入产物，**不建议跳过**（AGENTS.md 冻结条款：禁止改测试换绿）。
   - `decision=unevaluated`（测试器缺失/超时/输出溢出/输出不可解析）→ 结论"**门禁无法评估**"，原样记录 reason 与 tail。**不得写成"绿"**：这表示本次没拿到可信的 unit 结论，是否开联动由用户决定，产物中必须显式标注。
   - 隔离区非空 → 如实登记抖动测试名单与 flakyHits，提醒 exec 层若再遇同名失败先查 quarantine 不查应用。
   - `changeSurface.jointE2eSuggested=true`（本回合 src 与 webui 双侧都有改动）→ 在产物中**加粗提示**"改动面横跨前后端，本轮联动回归必做"；此提示只进报告，不自动触发。
3. **落盘**：产物写 `<被测系统>/e2e-artifacts/gate-preflight.md`，结构：

   ```markdown
   # 门禁预检 — <被测系统> <日期>
   - runner: <unit_tests_ex|pytest|jest|vitest|mocha|node-test|cargo|gotest|dotnet|make>
   - decision: <pass|block|unevaluated> (<reason>)
   - 基线: <count> 已知失败 <列名>（partial=true 时注明"仅覆盖子集"）
   - 隔离区: <flaky 名单与命中次数>
   - 改动面: backend=<bool> frontend=<bool> joint=<bool>
   - 结论: <可开联动 | 先修unit（清单） | 无法评估（原因）>
   ```

4. **交回总控**：产物路径与一句话结论返回。总控红线不变：名单与计划仍需用户确认后才执行 exec。

## 边界

- 本成员**只产状态说明，不启动浏览器、不跑 E2E、不碰驱动/服务**——那是 exec 成员的事（驱动能力委派 browser-use/computer-use 的家族豁免条款继续成立）。
- 被测系统没有测试栈（runner=null）→ **不要直接放行**。先查家族是否已接入 `harness-scaffold`（env 槽成员）：
  - 已接入 → 产物结论升级为"**无门禁覆盖，建议先由 harness-scaffold 造测试栈**（脚手架就位后 gate 自动检测纳入）"，把这条建议连同 scaffold 的 inputs（项目根/技术栈）一并交回总控，让总控在计划里排入 scaffold 成员；用户否决建议则按原样放行并标注"联动自行负责发现缺陷"。
  - 未接入（无该成员）→ 退回原行为：产出"无 unit 门禁覆盖，联动自行负责发现缺陷"并放行。
  两种情况缺口都如实标注，不静默。
- 对未装 test-gate 插件的环境：第 1 步退化为读状态文件，读不到则在产物中写明"门禁不可达"并放行（防御性原则：基建缺失不卡编排）。
