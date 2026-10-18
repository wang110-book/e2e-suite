# e2e-suite — 自进化测试脚手架家族

前后端联动测试的**技能家族 + 测试门禁**，设计为可跨平台迁移的测试能力资产。
本仓库同时是一个**插件市场**——客户端添加市场后可直接安装两个插件。

## 安装（推荐：插件市场）

在 ZCode 客户端的 插件 → 市场 → 添加市场 中填入仓库地址：

```
wang110-book/e2e-suite
```

添加后市场里会出现两个插件，按需安装：

| 插件 | 内容 | 何时装 |
|---|---|---|
| **e2e-suite-skills** | 总控 + 17 个契约化家族成员（纯方法论技能，无 hook） | 想要联动测试编排、用例设计、金丝雀自进化、测试脚手架蓝图 |
| **test-gate** | 测试门禁：Stop hook 收工把关 + MCP 三工具 + gate-cli（hooks/MCP/技能） | 想要"改完代码自动跑测试、红灯拦截" |

两个插件的 `gate-preflight` 成员互相咬合：联动开跑前先过单元闸。只装一个也能用，装齐才是完整闭环。

## 仓库结构

```
marketplace.json           市场清单（两个插件的索引）
e2e-suite-skills/          插件一：skills/<18 个家族技能>
test-gate/                 插件二：lib/ 判定引擎 + hooks/ mcp/ 宿主壳 + skills/ 家族成员
tools/sync.mjs             本机运行时 → 本仓库（维护者同步改动）
tools/install.mjs          本仓库 → 本机运行时（维护者部署）
```

## 非 ZCode 宿主 / CI 用法

`test-gate/lib/gate-core.mjs` 是纯 Node 判定引擎（零宿主依赖），任何能跑 node 的地方：

```bash
node gate-cli.mjs run /path/to/your-project    # 0=pass 1=block，stdout 为 JSON
```

自己接宿主薄壳（hooks/MCP）参考 `test-gate/hooks/gate-hook.mjs`（35 行）即可。

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

总控下次运行自动发现，零改动。详见 `e2e-suite-skills/frontend-backend-e2e/references/suite-contract.md`。

## 设计立场

- **纪律沉淀自真实事故**：断言必须能红、skip 计 PASS 要报 NOT-RUN、PUT 200≠生效要读回、免鉴权端点有副作用按破坏性对待、读不到显式 UNAVAILABLE——每条都有实测踩坑背书（见 `harness-scaffold/SKILL.md` 的坑注记）。
- **自进化**：金丝雀成员对账种子命中/漏抓，漏抓产出"只增式"进化提案，留进化日志、可否决回退；用例集按结算纪律逐轮晋升。
- **门禁与内容分离**：gate 只回答"这个项目有什么测试、绿不绿"，不关心测试内容——所以它零配置、可迁移。测试内容由 harness-scaffold 在各项目现场生成。

## 隐私声明

本仓库内容为通用方法论与引擎代码，不含任何特定项目的代码、凭据、私有路径或个人信息。

## License

MIT
