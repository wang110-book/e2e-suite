# e2e-suite — 自进化测试脚手架家族

前后端联动测试的**技能家族 + 测试门禁**，设计为可跨平台迁移的测试能力资产。

三句话：

- **家族（skills/）**：一个总控编排器 + 若干契约化成员技能，覆盖"环境准备 → 用例设计 → 执行 → 断言 → 报告 → 金丝雀自进化"全链。成员按契约块自声明，总控动态发现，接入新成员零改动总控。
- **门禁（plugins/test-gate/）**：平台无关的测试判定引擎（自动检测测试栈 → 跑 → 基线/抖动隔离/回归拦截），宿主薄壳可替换（ZCode hooks / MCP / CI CLI）。
- **脚手架（skills/harness-scaffold/）**：给任意新项目生成统一测试基础设施（共享能力库 + 分层入口 + 断言纪律 + 确定性夹具）的蓝图——"测试能力"真正可携带的形态。

## 目录

```
skills/              家族技能（每个一个目录，SKILL.md + references/）
plugins/test-gate/   测试门禁插件（lib/ 判定引擎 + hooks/ mcp/ 宿主壳 + skills/ 家族成员）
tools/sync.mjs       运行时 → 本仓库（日常开发后同步改动）
tools/install.mjs    本仓库 → 运行时（新平台部署）
```

## 快速开始（迁移到新机器/新平台）

```bash
# 1. 克隆本仓库
git clone <repo-url> e2e-suite && cd e2e-suite

# 2. 部署技能与插件到 ZCode 运行时（Windows/Linux/macOS 同构）
node tools/install.mjs

# 3. 门禁 CLI 在任何能跑 node 的地方可用（CI / 其它 agent 宿主）
node plugins/test-gate/lib/gate-cli.mjs run /path/to/your-project
#    退出码：0=pass / 1=block；stdout 为 JSON
```

非 ZCode 宿主：`gate-core.mjs` 是纯函数库（`findRoot/detect/runGate/status/reset`），自己接 20 行薄壳即可；`gate-cli.mjs` 已给出最小示例。

## 日常维护

改了运行时里的技能/插件后：

```bash
node tools/sync.mjs     # 运行时 → 仓库，然后 git commit
```

## 家族契约（接入新成员）

在成员技能 SKILL.md 正文加：

```markdown
## 家族契约（e2e-suite）

- phase: env|design|exec|assert|report|custom
- before: <phase/成员>
- after: <phase/成员>
- inputs: <消费的产物>
- outputs: <落盘的产物>
- idempotent: yes|no
```

总控下次运行自动发现。详见 `skills/frontend-backend-e2e/references/suite-contract.md`。

## 设计立场（为什么长这样）

- **纪律沉淀自真实事故**：断言必须能红、skip 计 PASS 要报 NOT-RUN、PUT 200≠生效要读回、免鉴权端点有副作用按破坏性对待、读不到显式 UNAVAILABLE——每条都有实测踩坑背书（见 `skills/harness-scaffold/SKILL.md` 的坑注记）。
- **自进化**：金丝雀成员（canary-calibration）对账种子命中/漏抓，漏抓产出"只增式"进化提案，留进化日志、可否决回退；用例集按结算纪律逐轮晋升（test-case-design）。
- **门禁与内容分离**：gate 只回答"这个项目有什么测试、绿不绿"，不关心测试内容——所以它零配置、可迁移。测试内容由 scaffold 在各项目现场生成。

## 隐私声明

本仓库内容为通用方法论与引擎代码，不含任何特定项目的代码、凭据、私有路径或个人信息。`harness-scaffold` 的参考实现（一个 Windows 代理项目）随其私有仓库，本仓库只携带从中抽象的通用蓝图。

## License

MIT
