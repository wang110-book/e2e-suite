# e2e-suite — 自进化测试脚手架家族

前后端联动测试的**技能家族 + 测试门禁**，设计为可跨平台迁移的测试能力资产。
本仓库同时是一个**插件市场**——客户端添加市场后可直接安装（一个整包，全功能）。

## 安装（推荐：插件市场）

在 ZCode 客户端的 插件 → 市场 → 添加市场 中填入仓库地址：

```
wang110-book/e2e-suite
```

添加后安装 **e2e-suite** 一个插件即得全部功能（技能家族 + 测试门禁 hooks + MCP 三工具）：

| 组成 | 内容 |
|---|---|
| skills/（21 个） | 总控 frontend-backend-e2e + 17 个契约化家族成员（含 harness-scaffold 脚手架蓝图）+ 门禁 3 技能（gate-guide / gate-preflight / tdd-loop） |
| hooks/ | Stop 收工把关：改完代码自动跑测试栈，基线全自动、抖动隔离、回归拦截 |
| mcp/ | `test_gate_status` / `test_gate_run` / `test_gate_reset` 三工具（见下文） |

## 仓库结构

```
marketplace.json           市场清单（github 源格式；.claude-plugin/ 下同步一份兼容）
e2e-suite/                 唯一插件（一体化）
  ├─ .zcode-plugin/plugin.json   插件清单（声明 skills + hooks + mcpServers）
  ├─ skills/<21 个技能>
  ├─ lib/gate-core.mjs     平台无关判定引擎
  ├─ lib/gate-cli.mjs      任意宿主 CLI 入口
  ├─ hooks/                ZCode Stop/PostToolUse 薄壳
  └─ mcp/server.mjs        MCP stdio 薄壳
tools/sync.mjs             本机运行时 → 本仓库（维护者同步改动）
tools/install.mjs          本仓库 → 本机运行时（维护者部署）
```

## MCP 三工具（装完插件即可被 AI 调用）

| 工具 | 作用 | 何时用 |
|---|---|---|
| `test_gate_status` | 只读查询：检测到的测试栈、脏文件、基线（已知失败）、抖动隔离区、日志尾部 | 想知道"门禁现在怎么看这个项目" |
| `test_gate_run` | 立即完整跑一次判定（构建+测试+基线比对），不等 Stop 事件 | 想现在就要红绿灯结论（CI 式触发） |
| `test_gate_reset` | 清除该项目门禁状态（基线/绿史/脏标记），回到"首红重新立基线"的宽容态 | 确实要重新宽容存量红时 |

拦截本身在 hooks（Stop 收工把关）——MCP 工具只能被模型主动调用，无强制力；两者配合：hook 管"别忘了跑"，MCP 管"随时可查可触发"。

## 非 ZCode 宿主 / CI 用法

`e2e-suite/lib/gate-core.mjs` 是纯 Node 判定引擎（零宿主依赖），任何能跑 node 的地方：

```bash
node e2e-suite/lib/gate-cli.mjs run /path/to/your-project    # 0=pass 1=block，stdout 为 JSON
```

自己接宿主薄壳（hooks/MCP）参考 `e2e-suite/hooks/gate-hook.mjs`（35 行）即可。

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
