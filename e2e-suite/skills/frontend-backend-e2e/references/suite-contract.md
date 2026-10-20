# e2e-suite 家族契约（成员技能接入协议）

> 本文件定义"前后端联动测试技能家族"的成员契约。总控（frontend-backend-e2e）**不写死任何成员名字**，只认契约标记与阶段槽位。新技能接入 = 在自己的 SKILL.md 正文加上契约块，总控下次运行时自动发现，无需修改总控。

## 一、契约块格式（成员自声明）

成员技能在 SKILL.md 正文（建议放在标题之后的第一个章节）加入：

```markdown
## 家族契约（e2e-suite）

- phase: env            <!-- 必填：本成员的主阶段，见下表 -->
- before: design        <!-- 可选：必须发生在哪些 phase/成员之前 -->
- after: env            <!-- 可选：必须发生在哪些 phase/成员之后 -->
- inputs: 被测系统的访问凭据与端口清单
- outputs: 环境说明（隧道端口/测试凭据/夹具清单/备份位置/还原命令）
- idempotent: yes       <!-- 可选：重复执行是否安全 -->
```

## 二、阶段槽位（phase）与默认顺序

| phase | 职责 | 当前成员 |
|---|---|---|
| `env` | 环境准备：版本确认/配置开关/观测预置/凭据与样例数据/备份还原/清理核验/**门禁体检/测试栈脚手架** | gate-preflight（test-gate 插件内，联动开跑先过 unit 闸） · harness-scaffold（项目无测试栈时按蓝图造脚手架，gate 随后自动纳入） · tool-config-guide（本机） |
| `design` | 测试集设计：用例矩阵/用例卡片/分级回归圈定 | test-case-design |
| `exec` | 测试执行：GUI 自动化/接口驱动/黑盒操作 | blackbox-e2e-test（功能侧） · negative-path-test · persistence-boundary-test · ux-acceptance-test（需求侧） · visual-design-review（视觉设计） · streaming-channel-test（流式/异步通道） |
| `assert` | 独立断言/校验器：契约比对/回归比对 | api-contract-diff · visual-regression |
| `report` | 报告渲染/汇总 | report-render |
| `custom` | 其他：性能探针/安全扫描/数据工厂 | whitebox-suite · perf-probe（性能基线+并发冲击） · canary-calibration（元验证+自进化） · platform-setup（分支测试平台，预留可选） |

## 生态对照与取舍（2026-08 调研：QASkills.sh 448 技能 / anthropics/skills / agentskills 社区包）

**采纳的行业标准做法**：黑盒旅程执行（业界 QA Agent 同款）、契约/漂移检测、可访问性验收（WCAG）、视觉审查 + **视觉回归基线比对**（业界标配，本家族 assert 层）、持久化/崩溃边界、报告渲染、白盒三件套。

**刻意不采纳**（保持家族通用与精简，需要时按契约块接入）：
- 框架绑定执行器（Playwright/Cypress/Selenium 专属技能）——本家族浏览器驱动与 harness 解耦；
- 专项负载工具链（k6/JMeter/Locust）未做成技能——常规并发冲击由 perf-probe 内建脚本并发 profile 覆盖（零安装）；超大压测需 k6 时本机已有则直接用，未装不擅自装；
- OWASP 深度安全测试——面向公网系统；内网管理面板按需再接；
- 移动端专项（Appium/Maestro）、SEO/营销页审计——超出"前后端联动测试"边界；
- 真人可用性研究/ A-B 测试——需真人样本，代理只能输出"建议真人验证点"。

默认执行顺序：`env → design → exec → assert → report`，随后由 design 类成员做用例集结算（自主迭代出下一版，见§三跨轮产物规则）；`custom` 按 `before/after` 声明插入。
同 phase 多成员：默认按声明顺序串行执行；用户可点名只跑其中若干。

> **`env` 槽位现状（2026-10-18 更新）**：
> - **`gate-preflight`**（本插件内，随 e2e-suite 一并安装；MCP 工具名前缀为
>   `mcp__plugin_e2e-suite_test-gate__*`）——联动开跑前的门禁体检；runner=null 时
>   建议接入 harness-scaffold 造栈。权威副本在插件 `skills/` 目录。
> - **`harness-scaffold`**（全局技能）——项目无测试基础设施时按蓝图生成共享能力库+分层入口+
>   纪律文档；参考实现见其 SKILL.md 末节。
> - **`tool-config-guide`**（本机通用工具/服务配置：版本确认、配置开关、观测预置、
>   凭据与样例数据、备份还原、清理核验），带契约块，**会被总控自动发现编排**。
> - 另有 **`e2e-env-setup`**（远程机/容器 隧道式环境搭建：SSH 端口转发、远程部署、
>   远程夹具生命周期）——它是 **detached 状态且设了 `disable-model-invocation: true`**，
>   总控**不会**发现它，模型也不会自动触发；**仅当用户显式调用时才用**。
>   需要"服务跑在远程机（控制面仅绑回环）、宿主机只做浏览器与隧道"的场景才走它。

## 三、输入/输出耦合规则（唯一允许的耦合）

成员之间**只通过"产物"衔接，不通过名字调用**：
- 上游成员的 `outputs` 必须覆盖下游成员 `inputs` 所需，编排时做匹配检查；
- 缺口 = 计划不成立 → 提示用户缺哪类成员，而不是静默跳过；
- 产物要落盘（环境说明/用例集/报告），保证任意成员可独立重跑与人工介入；
- **跨轮持久产物：用例集**（`test-cases-vN.md`）——exec 类成员以上轮文件为回归基线；每轮结束后由 design 类成员按"结算"纪律自主迭代出 `v(N+1)`（晋升三条件/防臃肿闸门，见 test-case-design 技能），旧版本保留、不过名覆盖。

## 三点五、测试文件命名空间（v1.2.2 起）

成员产出或修改测试文件时，一律遵循 [test-namespace 技能](../../test-namespace/SKILL.md)：`tests/<层级>/`（unit/api/e2e/ui）+ 各语言镜像命名（JS `*.test.*`、Python `test_*.py`、Go 同位置 `*_test.go`）。

**这不是风格偏好**：写在 runner 发现规则之外的测试文件永远不会被执行，而门禁会照常判定绿色——"假绿"由此产生。门禁在写时与收工两处给警告，不拦截。
- **跨轮持久产物：金丝雀语料与进化日志**（`canary.md` / `evolution-log.md`）——种子经"缺陷修复→通用性筛选→种子化"闭环入库；家族自进化以"日志可回退"为前提，用户可随时否决回退。

## 四、总控的发现机制

1. 扫描技能目录下所有 `*/SKILL.md`，grep 标记 `家族契约（e2e-suite）`（**总控自身除外**）；
2. 解析各成员的 phase/before/after/inputs/outputs；
3. 生成执行计划（含发现到的成员名单、顺序、产物链）**先呈现给用户确认**，再逐个通过 Skill 工具加载执行。

### before/after 的解析规则（v1.2.0 起由 `lib/family.mjs` 统一实现）

- 值可以是 **phase 名**（`env`/`design`/`exec`/`assert`/`report`）或**成员名**，逗号分隔多个；
- 括号内的说明会被剥离，`after: assert（默认最后执行）` 按 `assert` 处理；
- 相位序 `env→design→exec→assert→report` 只是默认，`before`/`after` 在其之上做稳定拓扑修正；`custom` 默认排在 `report` 之后，靠约束插入；
- 约束成环时**不会死循环**：回退到相位序并在结果的 `conflicts` 里报告，交人工裁决；
- `phase` 只接受上述六个值，写成别的（如 `setup`）该成员不会入列——这是刻意的，防止拼写错误静默改变编排。

## 五、接入新成员的三步

1. 新技能的 SKILL.md 正文加契约块（本文件第一节的格式）；
2. 在正文写清自己的方法论（总控不关心细节，只调度）；
3. 无需改总控——下次联动测试自动被发现。若新成员与现有成员存在顺序要求，用 before/after 表达。
