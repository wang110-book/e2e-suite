# e2e-suite — 自进化测试脚手架家族

前后端联动测试的**技能家族 + 测试门禁**，设计为可跨平台迁移的测试能力资产。
本仓库同时是一个**插件市场**——客户端添加市场后可直接安装（一个整包，全功能）。

## 安装（推荐：插件市场）

在 ZCode 客户端的 插件 → 市场 → 添加市场 中填入仓库地址：

```
wang110-book/e2e-suite
```

添加后安装 **e2e-suite** 一个插件即得全部功能（技能家族 + 测试门禁 hooks + MCP 四工具（含家族发现入口 family_skills））：

| 组成 | 内容 |
|---|---|
| skills/（22 个） | 总控 frontend-backend-e2e + 19 个契约化家族成员（含 test-namespace 命名空间、harness-scaffold 脚手架蓝图、gate-preflight / tdd-loop / test-case-design）+ gate-guide 门禁指南 + e2e-env-setup（detached，仅显式调用） |
| hooks/ | Stop 收工把关：改完代码自动跑测试栈，基线全自动、抖动隔离、回归拦截 |
| mcp/ | `test_gate_status` / `test_gate_run` / `test_gate_reset` + `family_skills`（家族发现与编排入口） |

## 仓库结构

```
marketplace.json           市场清单（github 源格式；.claude-plugin/ 下同步一份兼容）
e2e-suite/                 唯一插件（一体化）
  ├─ .zcode-plugin/plugin.json   插件清单（声明 skills + hooks + mcpServers）
  ├─ skills/<22 个技能>
  ├─ lib/gate-core.mjs     平台无关判定引擎
  ├─ lib/gate-cli.mjs      任意宿主 CLI 入口
  ├─ lib/family.mjs        家族成员发现与 before/after 拓扑编排
  ├─ hooks/                ZCode Stop/PostToolUse 薄壳
  └─ mcp/server.mjs        MCP stdio 薄壳
tests/gate-core.test.mjs   门禁与编排的回归测试（node --test，零依赖）
tools/bump.mjs             统一五处版本号（发版必跑，否则客户端更新不到）
tools/sync.mjs             本机运行时 → 本仓库（维护者同步改动）
tools/install.mjs          本仓库 → 本机运行时（维护者部署）
```

## 发版流程（重要）

ZCode 的插件更新是**版本号驱动**的：`marketplace.json` 里的 `version` 不变，即使仓库代码变了，客户端执行 `zcode plugins update` 也只会得到 `already up to date`，已安装缓存（`cache/<市场>/<插件>/<版本>/`）不会重新拉取。

所以**每次发版必须改版本号**，且五处要一致：

```bash
node tools/bump.mjs 1.3.0     # 统一 package.json / 两份 marketplace / plugin.json / server.mjs
node --test tests/gate-core.test.mjs
git add -A && git commit -m "..." && git push
```

`bump.mjs --check` 会校验五处是否一致，已接入测试（第 14 条用例），漏改会被门禁拦下。

客户端更新（三步，缺一不可）：

```bash
zcode plugins update e2e-suite@e2e-suite   # 先刷新市场再拉新版本
# 重启 ZCode 宿主 —— hooks 与 MCP 只在启动时加载
```

版本号不会自动递增，也没有后台轮询：市场目录会自动刷新，但**已安装的插件不会自己更新**。

## MCP 工具（装完插件即可被 AI 调用）

| 工具 | 作用 | 典型场景 |
|---|---|---|
| `test_gate_status` | 只读查询：检测到的测试栈、脏文件、基线（已知失败）、抖动隔离区、日志尾部 | 想知道"门禁现在怎么看这个项目" |
| `test_gate_run` | 立即完整跑一次判定（构建+测试+基线比对），不等 Stop 事件 | 想现在就要红绿灯结论（CI 式触发） |
| `test_gate_reset` | 清除该项目门禁状态（基线/绿史/脏标记），回到"首红重新立基线"的宽容态 | 确实要重新宽容存量红时 |
| `family_skills` | **家族测试入口**：扫描契约块发现全部在册成员，返回清单（phase/inputs/outputs）+ 按 `before`/`after` 拓扑排出的执行计划（env→design→exec→assert→report，custom 按约束插入；成环会显式报告 conflicts） | 想知道"这个项目装了哪些家族成员、联动该按什么顺序跑"；拿到计划后用宿主 Skill 工具逐个加载执行 |

拦截本身在 hooks（Stop 收工把关）——MCP 工具只能被模型主动调用，无强制力；两者配合：hook 管"别忘了跑"，MCP 管"随时可查可触发"。`family_skills` 只发现与排程，不加载技能——加载与计划确认是宿主/用户的职责（编排红线不变）。

### 三种判定结果

| decision | 含义 | hook 行为 |
|---|---|---|
| `pass` | 全绿 / 失败都在基线或隔离区内 / 抖动放行 / 本回合没改代码 | 放行 |
| `block` | 新增失败、回归、构建失败 | exit 2 打回会话 |
| `unevaluated` | **门禁无法评估**：测试器缺失、超时、输出溢出、输出不可解析 | 放行会话但显式告警（不伪装成绿） |

`unevaluated` 是 v1.2.0 新增的显式状态。此前超时（`ETIMEDOUT`）、输出超限（`ENOBUFS`）、解析失败都被折叠成 `pass`，看起来像一次成功把关。

### 测试文件命名空间（v1.2.2）

写测试文件的放置与命名规范，作为独立技能 [test-namespace](e2e-suite/skills/test-namespace/SKILL.md) 交付（`description` 命中"新建/移动测试、测试没跑起来、审查测试树"即触发）：目录 `tests/<层级>/`（unit/api/e2e/ui）+ 各语言镜像命名（JS `*.test.*`、Python `test_*.py`、Go 同位置 `*_test.go`、C++ 需注册进聚合目标）。

**为什么重要**：runner 只发现符合其命名规则的文件。写在规则之外的测试**永远不会执行**，而门禁照常判定绿色——这是"假绿"的主要来源。

门禁的自动提醒（都不拦截，`TEST_GATE_NS=0` 可关）：

- **写时**：PostToolUse 检测到偏离立刻在 stderr 打 `[test-gate][namespace]`，agent 当轮就能改；
- **收工**：Stop 判定结果的 `nsWarnings` 里带去重清单。

两类：`test-outside-namespace`（测试文件在 tests/ 树外，Go/Rust 同位置惯例除外）、`test-will-not-be-discovered`（tests/ 树内含测试声明但命名不符发现规则）。

**只检测测试文件，不误报普通项目文件**：`tests/` 下的 `setup.js`、`mocks/*`、`factories/*`、`helpers.js` 这类非测试代码不会被打扰——判定靠**读文件内容**（有没有 `test(` / `def test_` / `#[test]` / `[Fact]` 等测试声明），不是只看路径。

## 非 ZCode 宿主 / CI 用法

`e2e-suite/lib/gate-core.mjs` 是纯 Node 判定引擎（零宿主依赖），任何能跑 node 的地方：

```bash
node e2e-suite/lib/gate-cli.mjs run /path/to/your-project    # 0=pass 1=block 3=unevaluated，stdout 为 JSON
```

自己接宿主薄壳（hooks/MCP）参考 `e2e-suite/hooks/gate-hook.mjs` 即可。

## 自测

```bash
node --test tests/gate-core.test.mjs
```

覆盖：基线生命周期、TIA 子集跑测、各运行器失败名解析、超时/输出溢出、构建失败、跨盘符脏标记、家族拓扑编排与成环检测。

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

总控下次运行自动发现，零改动。详见 `e2e-suite/skills/frontend-backend-e2e/references/suite-contract.md`。

## 设计立场

- **纪律沉淀自真实事故**：断言必须能红、skip 计 PASS 要报 NOT-RUN、PUT 200≠生效要读回、免鉴权端点有副作用按破坏性对待、读不到显式 UNAVAILABLE——每条都有实测踩坑背书（见 `harness-scaffold/SKILL.md` 的坑注记）。
- **自进化**：金丝雀成员对账种子命中/漏抓，漏抓产出"只增式"进化提案，留进化日志、可否决回退；用例集按结算纪律逐轮晋升。
- **门禁与内容分离**：gate 只回答"这个项目有什么测试、绿不绿"，不关心测试内容——所以它零配置、可迁移。测试内容由 harness-scaffold 在各项目现场生成。

## 隐私声明

本仓库内容为通用方法论与引擎代码，不含任何特定项目的代码、凭据、私有路径或个人信息。

## License

MIT
