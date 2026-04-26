# 编译为单文件二进制 (bun build --compile)

## 目标

把 restored 源码树编译成原生可执行文件 `bin/claude`(Mach-O arm64),替代原来的 shell 启动脚本。配合 `scripts/package-runtime.sh` 一起使用,打出的 tarball 里 `bin/claude` 就是真正的二进制。

## 一键命令

```bash
bun run scripts/build-binary.ts      # 生成 bin/claude (约 77 MB)
bun run package:runtime              # 打出含二进制的 dist tarball
```

目标机运行:`./bin/claude`(**不再需要装 bun**;但 `node_modules` / `src` / `shims` 仍需随 tarball 分发,因为 `sharp`、OTEL exporters、`image-processor.node` 等是运行时动态加载)。

## 为什么要 `scripts/build-binary.ts` 而不是直接 `bun build --compile`

restored 源码树有三类"静态编译杀手",`bun run` 惰性解析能跑,`bun build --compile` 严格静态分析会炸:

1. **缺失的相对导入**(文件整个不存在)—— 8 个,例如 `src/tools/REPLTool/REPLTool.ts`、`src/ink/devtools.ts`、`src/services/compact/cachedMicrocompact.ts`。
2. **缺失的 re-exports**(文件在但少导出)—— 目前只有 `src/utils/filePersistence/types.ts` 缺 `DEFAULT_UPLOAD_CONCURRENCY` / `FILE_COUNT_LIMIT` / `OUTPUTS_SUBDIR` / `FailedPersistence` / `FilesPersistedEventData` / `PersistedFile`。
3. **缺失的 bare optional deps** —— 18 个,例如 `sharp`、`turndown`、OTEL 各种 exporter、`@aws-sdk/client-bedrock`、`@anthropic-ai/{bedrock,vertex,foundry}-sdk`、`@azure/identity`。

`scripts/build-binary.ts` 的三板斧:

| 问题 | 处理 |
|---|---|
| 缺失文件 | 构建前写临时空 stub (`export default {}`),构建后删除 |
| 缺失 re-exports | 构建前 append 到原文件尾部,构建后从备份还原 |
| 缺失 bare 依赖 | `bun build --external <name>` 跳过静态解析 |
| 原生模块 | `--external '*.node'` |

所有临时改动在 `try/finally` + `process.on('exit')` 里统一回滚 —— **源码树保持干净**,符合"保留已有逻辑"原则。

## 踩过的坑

### 坑 1:Bun 插件方案触发 segfault

第一版尝试 `Bun.build({ plugins: [stubPlugin] })` 用 `onResolve` 动态 stub,Bun 1.3.11 会 panic(`Segmentation fault at address 0xAAAAAAAAAAAAAF9A`)。即使把 compile 拆成两步(先 bundle 再 compile)也一样崩。

**结论**:放弃插件路线,改成**磁盘上写真实临时文件** + 原生 `bun build --compile`。这才是 Bun 1.3.x 上能跑通的唯一姿势。

### 坑 2:TS 风格的 `./foo.js` 解析

一开始的插件路径 stub 逻辑 `candidate + ext` 没处理 TS 源码里 `import './main.js'` 实际指向 `main.tsx` 的情况,导致把真实文件当缺失全 stub 掉。修复:先 `stripped = candidate.replace(/\.(js|jsx|mjs|cjs)$/, '')` 再尝试 `.ts`/`.tsx`。(当前磁盘 stub 方案用不到这段,但留作后续插件路线可行时的参考。)

### 坑 3:onResolve 返回 `null` vs `undefined`

Bun 插件规范要求"放行"时返回 `undefined`,返回 `null` 会触发崩溃。

### 坑 4:`file://` import + dynamic require

`src/tools.ts` 里用 `require('./tools/REPLTool/REPLTool.js')` 这种 CommonJS 风格动态 require 也会被静态分析到 —— 同样靠 stub 文件搞定,不需要改 `tools.ts`。

## 新增缺失项时如何扩展

当 Bun 报新的 `Could not resolve` 时:

1. **bare 模块**(`@scope/name` 或 `name`)→ 加到 `MISSING_BARE` 数组。
2. **相对路径且文件不存在** → 加到 `MISSING_RELATIVE` 数组(注意扩展名要匹配 TS 预期:`.ts` / `.tsx`)。
3. **相对路径但缺导出** → 加到 `APPEND_EXPORTS`,key 是文件路径,value 是要追加的文本(用 `// --- build-binary.ts appended stubs ---` 前缀确保幂等)。

每次只需重跑 `bun run scripts/build-binary.ts`,成功的标志是:

```
 [XXXms]  bundle  NNNN modules
 [XXXms] compile  .../bin/claude
```

然后用 `file bin/claude` 确认 `Mach-O 64-bit executable arm64`,`./bin/claude --version` 能打印版本号。

## 与 `package-runtime.sh` 的关系

- `scripts/build-binary.ts` 只负责编译 `bin/claude`。
- `scripts/package-runtime.sh` 负责把 `bin` + `src` + `node_modules` + `shims` + `vendor` + `skills` + `image-processor.node` 等打成 tarball。
- 典型流程:**先编译,后打包**。
  ```bash
  bun run scripts/build-binary.ts && bun run package:runtime
  ```

`package-runtime.sh` 不需要任何修改 —— 它本来就把 `bin/` 原样打包,`bin/claude` 从 shell 脚本变成二进制文件对它完全透明。这就是"复用已有逻辑"。

## 注意事项

- 编译出的 `bin/claude` **架构绑定**:`darwin-arm64` 不能在 Intel Mac 上跑。要分发 Intel 版需在 x86_64 机器上重跑 `build-binary.ts`(脚本会自动检测 `process.arch`)。
- 目标机仍需源码树 + `node_modules`:`--external` 掉的模块在运行时是通过 `import()` 从磁盘加载的,不在二进制内。所以**单文件二进制 ≠ 完全脱离 tarball**,它只是把 `bin/claude` 这个入口做成了不依赖 bun 的原生可执行文件。
- 如果将来把 restored 源码树的缺失项补齐了(恢复出真正的 REPLTool 等),应从 `MISSING_*` 数组里**及时删除**对应条目,避免 stub 覆盖真实实现。
