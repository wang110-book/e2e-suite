# 测试文件命名空间规范（e2e-suite test-namespace）

> 本文件是所有平台 agent 写测试文件时的**唯一权威规范**。tdd-loop、harness-scaffold、
> gate-guide 技能及门禁内核均引用此处。规范的目标只有一个：**新写的测试必须被项目
> 的 runner 发现并执行**——写在 runner 发现规则之外的测试等于没写，门禁会照常绿。

## 一、目录命名空间

测试树以 `tests/` 为根，一级子目录即测试层级（对齐 harness-scaffold 的分层入口）：

```
tests/
  unit/        纯函数/模块级测试        最快，无外部依赖
  api/         控制面接口测试            只打 HTTP/API，不起浏览器
  e2e/         端到端（真实服务+驱动）    慢，里程碑跑
  ui/          浏览器 GUI 层测试         最贵
  harness/     共享能力库（非测试文件，runner 不发现，不在此写用例）
  testdata/    夹具与样本数据（非测试文件）
```

**允许的历史别名**：`test/`、`spec/`、`__tests__/` 作为根同样受门禁认可（很多项目
先于规范存在）。新文件一律进上表目录。

## 二、文件命名——各语言的镜像绑定

规范的本质：**测试文件的模块名必须能从被测源文件机械推导**（门禁的 TIA 与命名检查
依赖这一点）。每平台一种绑定形态：

| 平台 | 命名 | 位置 | 被谁发现 |
|---|---|---|---|
| JS/TS | `<module>.test.mjs`（或 `.test.js/.test.ts`） | `tests/<层级>/` 内 | node --test / vitest / jest |
| Python | `test_<module>.py` | `tests/<层级>/` 内 | pytest |
| Go | `<module>_test.go` | **与被测源文件同目录**（Go 惯例，唯一例外） | go test |
| Rust | 单测留在 src 内 `#[cfg(test)] mod tests`；集成测试 `tests/<module>.rs` | `tests/` 顶层 | cargo test |
| C++/CMake | `<module>_test.cpp` | `tests/<层级>/` + **手动注册进聚合测试目标** | 构建目标（唯一需手动注册） |
| .NET | `<Module>Tests.cs` | 测试项目 `Tests/` 目录下 | dotnet test |

**反例（禁止）**——这些写法会让 runner 静默漏掉，是"假绿"的头号来源：

- `tests/unit/parser.js`（JS 文件不带 `.test.` → node --test 不收；实测验证）
- `tests/helpers.py` 里写了 assert（不是 `test_*` → pytest 不收）
- `src/foo.test.py`（前缀规则颠倒 → 不收）

**非测试文件的合法驻留区**：`tests/harness/`、`tests/testdata/`、`tests/fixtures/`
下的文件不要求测试命名模式；除 `harness/`、`testdata/` 外的目录里出现"看起来是测试"
的命名（如 `parser.spec.js` 落在非测试目录）会被门禁记一条警告。

## 三、机械防线（gate v1.2.2 起）

1. **写时警告**（PostToolUse）：你往规范外的位置写测试命名的文件时，hook 立即在
   stderr 打一条 `[test-gate][namespace]` 警告，指明应放的位置。不拦截。
2. **收工汇总**（Stop）：判定结果的 `messages` 里附带本回合的命名空间警告去重清单。
   不拦截（项目历史目录结构不应被强拆；`TEST_GATE_NS=0` 可整体关闭）。
3. **TIA 支持嵌套**：pytest 源文件→测试映射改为递归搜索 `tests/` 各层级。

## 四、给 agent 的一句话纪律

写任何测试文件前：先看项目已有测试树跟着放；项目没有测试树，就按本文件第一节建
`tests/<层级>/`，命名按第二节对应语言的绑定表。写完确认它被 runner 执行（跑了 ≠ 绿了，
看用例数是否增加了这一条）。
