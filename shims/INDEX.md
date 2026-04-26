# `shims/` 模块索引

## 目录定位

`shims/` 提供本仓库恢复过程中缺失私有包、原生依赖或平台模块的兼容实现。`package.json` 中多个 `file:./shims/...` 依赖直接指向这里。

## Shim 列表

| 目录 | 作用 |
| --- | --- |
| `ant-claude-for-chrome-mcp/` | Chrome MCP 相关兼容包 |
| `ant-computer-use-input/` | Computer Use 输入层兼容包 |
| `ant-computer-use-mcp/` | Computer Use MCP 兼容包，包含 `sentinelApps.ts`、`types.ts` |
| `ant-computer-use-swift/` | Swift/native computer-use 桥接兼容层 |
| `color-diff-napi/` | 原生 diff 能力替代层 |
| `modifiers-napi/` | 修饰键/输入相关 native 接口替代层 |
| `url-handler-napi/` | URL handler native 接口替代层 |

## 阅读重点

- 每个 shim 目录基本都只有 `index.ts` + `package.json`
- 这里的代码应尽量保持“最小可运行兼容层”，不要把真实业务逻辑继续堆进 shim
- 如果某个 shim 行为异常，通常还要联动查看 [../vendor/INDEX.md](../vendor/INDEX.md) 中的对应源码占位

## 关联模块

- 源码占位见 [../vendor/INDEX.md](../vendor/INDEX.md)
- 工具/服务调用端见 [../src/tools/INDEX.md](../src/tools/INDEX.md) 与 [../src/services/INDEX.md](../src/services/INDEX.md)
