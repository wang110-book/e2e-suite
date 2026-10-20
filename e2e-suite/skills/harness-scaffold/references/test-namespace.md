# 测试文件命名空间规范（e2e-suite test-namespace）

> **本文件是兼容入口**：完整规范已升级为独立技能
> [`skills/test-namespace/SKILL.md`](../../test-namespace/SKILL.md)，其中包含目录层级、
> 各语言绑定表、禁止写法、以及"如何确认测试真的被执行"的核验方法。
>
> 保留本文件是为了不破坏既有链接（tdd-loop / gate-guide / suite-contract 曾指向此处）。

## 速查

- 目录：`tests/<层级>/`，层级为 `unit` / `api` / `e2e` / `ui`；`harness/`、`testdata/`、`fixtures/` 放非测试文件。
- 命名：JS `*.test.*`、Python `test_*.py`、Go 同目录 `*_test.go`、Rust 源内 `#[cfg(test)]` 或 `tests/*.rs`、C++ `<module>_test.cpp` 且需注册进聚合目标、.NET `*Tests.cs`。
- 铁律：**写在 runner 发现规则之外 = 永不执行 = 门禁照常绿 = 假绿**。
- 核验：看用例名是否出现在输出里，而不是只看退出码。

详见 [test-namespace 技能](../../test-namespace/SKILL.md)。
