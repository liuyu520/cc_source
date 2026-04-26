# `scripts/` 模块索引

## 目录定位

`scripts/` 是仓库级辅助脚本目录，负责构建、打包和部分状态检查。

## 脚本清单

| 文件 | 作用 |
| --- | --- |
| `build-binary.ts` | 构建二进制相关脚本 |
| `check-advisory-contract.ts` | Advisory 契约漂移三层体检(Ph97);exit 0=clean,1=drift |
| `dream-status.ts` | dream/演化状态检查脚本 |
| `package-runtime.sh` | 运行时打包脚本，`package:runtime` 直接调用它 |

## 使用建议

- 变更发布/打包流程时先看这里
- 如果脚本依赖运行时代码，通常还要联动 [../src/entrypoints/INDEX.md](../src/entrypoints/INDEX.md) 与 [../src/services/INDEX.md](../src/services/INDEX.md)
