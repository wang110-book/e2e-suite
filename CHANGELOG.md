# Changelog

按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。
记录本插件**对外行为**的变化；内部重构与测试补充不单列。

## 1.2.4 — 2026-10-20

### 新增
- `CHANGELOG.md`：对外行为沿革集中到版本历史，README 只留现状说明与流程。

### 变更
- **canary-bootstrap 收尾从"自删目录"改为"自脱离"**：技能随插件装缓存后，删缓存文件会被下次
  更新/重新部署整体拉回，"永久消失"语义失效。现改为契约块改名（`家族契约（e2e-suite）`→
  `（e2e-suite-暂停）`，与 e2e-env-setup 同款机制），脱离发现名单稳定成立且重触发幂等。
- **维护工具跟随安装现实**：`sync.mjs` / `install.mjs` 的数据源从已删除的 dev-default-plugins
  市场路径改为读 `installed_plugins.json` 解析 e2e-suite 实际安装缓存（版本目录动态跟随）。
  install 增加版本门控：仓库版本 ≠ 已安装版本时不推（防"清单 1.2.3、内容 1.2.4"缝合怪），
  提示走正式发布路径。两工具在此修正前对当前环境均已静默失效。
- 文档陈旧措辞清理：suite-contract / gate-preflight 中"test-gate 插件"改为"e2e-suite 插件（test-gate 门禁）"，
  修复 suite-contract §三 列表被"三点五"节割断的结构错误。

### 工程
- `.gitattributes`（`text=auto eol=lf` + 二进制白名单）：消除每次 commit 的 CRLF 警告刷屏。

## 1.2.3 — 2026-10-20

### 新增
- **test-namespace 独立技能**：测试文件放置与命名的完整指引（目录层级、各语言绑定表、禁止写法、
  "如何确认测试真的被执行"的核验方法）。description 命中"新建/移动测试、测试没跑起来、审查测试树"即触发，
  任意平台加载家族技能的 agent 都能拿到规范，而不只靠 hook 报警。
- 门禁命名空间检查（v1.2.2 引入）扩展豁免目录：`tests/mocks`、`__mocks__`、`factories`、`__fixtures__`。

### 变更
- **命名空间检查改为内容判定**：读文件内容识别测试声明（`test(` / `def test_` / `#[test]` / `[Fact]` / `TEST(` 等）
  才认定为测试文件。此前按路径+命名判定，会把 `tests/` 下的 `setup.js`、`mocks/`、`factories/`、`helpers.js`
  等合法非测试文件误报——现在只检测测试文件，绝不打扰普通项目代码（宁可漏报，绝不误报）。
- 家族编排成员 18 → 19（test-namespace 入列，phase=design）。

## 1.2.2 — 2026-10-20

### 新增
- **测试文件命名空间规范**：`tests/<层级>/`（unit/api/e2e/ui）+ 各语言镜像命名。初版为
  harness-scaffold 下的 reference 文档，四处技能引用（tdd-loop / harness-scaffold / gate-guide / suite-contract）。
- **门禁命名空间警告**（均不拦截，`TEST_GATE_NS=0` 可关）：写文件时（PostToolUse）即时提醒、
  收工时（Stop）在 `nsWarnings` 里汇总。两类：`test-outside-namespace`、`test-will-not-be-discovered`。
- TIA（pytest）源文件→测试映射支持 `tests/unit/`、`tests/api/` 等嵌套层级。

## 1.2.1 — 2026-10-18

### 新增
- `tools/bump.mjs`：一条命令统一五处版本号（package.json / 两份 marketplace.json / plugin.json / server.mjs），
  支持 `--dry` 与 `--check`。ZCode 的插件更新是版本号驱动，五处漏改一处就等于这次更新没人能收到。
- bump.mjs --check 接入回归测试，漏改版本号即红灯（门禁会拦）。

### 变更
- 仓库根新增 `package.json`：此前仓库没有任何测试栈锚点，门禁对本仓库报 `no-test-stack`——
  自己写的回归测试从未被门禁保护。补锚点后 `detectedRunner=node-test`，回归测试纳入门禁。
- README 补发版流程与客户端更新三步（含"重启宿主"的必要性）。

## 1.2.0 — 2026-10-18

### 新增
- **unevaluated 第三态**：门禁无法评估（测试器缺失、超时 ETIMEDOUT、输出溢出 ENOBUFS、输出不可解析）
  不再折叠成 `pass`；hook 放行会话但显式告警，CLI 以 exit 3 区分。gate-preflight 产物分支同步支持。
- **多运行器失败名解析**：jest / vitest / mocha / `node --test` / pytest / cargo / go / dotnet / CMake
  各用各的解析器，名字剔除耗时后缀。此前 npm test 一律套 jest 符号行，`node --test` 恒红被误判成
  抖动永久放行、vitest/mocha 解析不出名字。
- `lib/family.mjs`：家族成员发现与 **before/after 真拓扑编排**（支持 phase 名/成员名/逗号列表/括号注释，
  成环回退相位序并报告 conflicts）。此前 `before` 被完全忽略，14/15 条 after 声明失效。
- 回归测试套件 `tests/gate-core.test.mjs`（node --test，初版 13 条，逐缺陷对应）。

### 修复
- 构建首次失败被永久放行：现按"首红登记、之后打回"的基线生命周期处理，构建恢复后基线自动作废。
- TIA 子集跑测全绿误清基线、伪造绿史：子集绿一律不动基线、不写绿史。
- sync.mjs 会用旧运行时覆盖仓库：默认改为只报告、`--force` 才写入；`mcp/` 永不反向同步。
- Stop hook 超时 660s 无余量（构建 360s+测试 300s 恰好相等）→ 900s；`.mcp.json` 同调。
- 跨盘符编辑被记为项目内改动（Windows `path.relative` 返回绝对路径）；`findRoot` 上溯深度 6→12。
- `skipDirtyCheck` 死参数落地。

## 1.1.0 — 2026-10-18

### 新增
- MCP 工具 `family_skills`：家族成员发现（扫描插件自带 / `~/.zcode/skills` / 项目 `.zcode/skills` 三根，
  解析契约块）与编排计划返回。detached 与无契约块成员不入列。

## 1.0.0 — 2026-10-18

### 初始发布
- **测试门禁（test-gate）**：Stop hook 收工把关——PostToolUse 记脏、自动检测测试栈
  （npm/pytest/cargo/go/dotnet/CMake/make）、首红立基线、只拦新增失败、全绿清基线、
  绿后红打回、抖动重跑隔离（flakyHits≥2 进隔离区、连续 10 绿回炉）、TIA 影响面选择（pytest/go）。
- **技能家族**：总控 frontend-backend-e2e（契约式动态发现与编排）+ 契约化成员：
  blackbox-e2e-test、negative-path-test、persistence-boundary-test、streaming-channel-test、
  ux-acceptance-test、visual-design-review、visual-regression、api-contract-diff、report-render、
  test-case-design、perf-probe、canary-bootstrap、canary-calibration、whitebox-suite、
  harness-scaffold、tdd-loop、tool-config-guide、e2e-env-setup（detached）。
- 门禁技能三件套：gate-guide（使用与恢复）、gate-preflight（家族 env 槽联动体检）、tdd-loop。
- MCP 三工具 `test_gate_status` / `test_gate_run` / `test_gate_reset`；平台无关判定引擎 + `gate-cli`。
- 仓库即插件市场（`.claude-plugin/marketplace.json` 兼容双查找路径）。
