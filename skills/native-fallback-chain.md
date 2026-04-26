# Native 模块降级与回退链模式

## 目标

本项目多处使用"先尝试 native 模块 → 失败则回退到纯 JS/osascript 方案"的降级策略。本文档总结此模式的正确实现方式和常见陷阱。

## 模式概览

```
feature gate check
  ↓
try {
  native = await import('xxx-napi')
  result = native.doSomething()
  if (!result) return null  // ← 危险：native 的 null 是权威的，跳过回退
} catch {
  // 模块不存在 / 加载失败 → 落到回退
}
  ↓
// 回退路径（osascript / sharp / JS polyfill）
```

## 项目中的实例

### 1. 剪贴板图片读取 (`imagePaste.ts`)

```
image-processor-napi (readClipboardImage)
  → catch → osascript «class PNGf» (darwin)
  → catch → xclip / wl-paste (linux)
  → catch → powershell Get-Clipboard (win32)
```

**关键点**: native 的 `readClipboardImage` 返回 `null` 表示"剪贴板无图片"，这是**权威结论**，不应继续 osascript 回退。只有 import/调用**抛异常**时才回退。

### 2. 图片处理 (`imageProcessor.ts`)

```
image-processor-napi (sharp 实现)
  → catch → sharp (npm 包)
```

**关键点**: `isInBundledMode()` 控制是否尝试 native。非 bundled 模式直接用 sharp。

### 3. 剪贴板检测 (`hasImageInClipboard`)

```
image-processor-napi (hasClipboardImage)
  → catch → osascript «class PNGf» (仅 darwin)
```

**关键点**: 非 darwin 平台直接 `return false`，不尝试任何检测。

## 常见陷阱

### 陷阱 1：null 返回 vs 异常抛出

```typescript
// ❌ 危险模式
try {
  const native = nativeModule.read()
  if (!native) return null      // native 说"没有" → 跳过回退
} catch {
  // 只有异常才走回退
}
// 回退代码（永远不会执行，如果 native 返回 null）
```

**问题**：如果 native 模块是个 stub（部署时打包不全），它可能返回 `null` 而不是抛异常。此时回退路径被完全跳过。

**修复思路**：如果不确定 native 模块是否可靠，考虑在 null 返回时也走回退：

```typescript
try {
  const native = nativeModule.read()
  if (native) return processNative(native)
  // null → 落到回退，而非 return null
} catch {
  // 异常 → 落到回退
}
// 回退代码
```

但当前代码的设计是**有意的**：native 的 null 是"剪贴板确实没有图片"的权威结论，比 osascript 更快更准。只是在 native 模块残缺时会有问题。

### 陷阱 2：feature gate 与 try/catch 的关系

```typescript
if (feature('NATIVE_CLIPBOARD_IMAGE') && ...) {
  try {
    // native path
  } catch {
    // 回退到下方 osascript
  }
}
// osascript 回退
```

`feature()` 是编译时 tree-shake gate：
- **开启**（默认）: 整个 if 块保留，try/catch 正常工作
- **关闭**: 整个 if 块被移除，直接走 osascript

这是 kill-switch 模式：默认开启 native，出问题时可通过 GrowthBook 远程关闭。

### 陷阱 3：回退路径的平台适配

```typescript
// imagePaste.ts:getClipboardCommands()
const commands = {
  darwin: { checkImage: `osascript -e '...'`, ... },
  linux:  { checkImage: 'xclip ... || wl-paste ...', ... },
  win32:  { checkImage: 'powershell ...', ... },
}
```

回退路径本身也有平台差异。添加新的 native 模块时：
1. native 模块失败 → 确认每个平台都有正确的回退
2. 回退命令的依赖（xclip、wl-paste）不一定已安装

## 添加新的 native 降级链的清单

1. **定义 feature gate**（如果需要远程 kill-switch）
2. **native 路径**: `try { await import('xxx-napi') } catch { /* 回退 */ }`
3. **明确 null 语义**: native 返回 null 是"权威的无结果"还是"应该回退"？
4. **回退路径**: 每个目标平台都有可用的 fallback
5. **日志**: `logError(e)` 记录 native 失败原因，不要静默吞掉
6. **测试**: 模拟 native 模块不存在时（`MODULE_NOT_FOUND`），确认回退正常工作

## 关键代码位置

| 功能 | 文件 | native 模块 | 回退方案 |
|------|------|------------|---------|
| 剪贴板图片读取 | `src/utils/imagePaste.ts:124` | `image-processor-napi` | osascript / xclip |
| 剪贴板检测 | `src/utils/imagePaste.ts:96` | `image-processor-napi` | osascript |
| 图片处理 (sharp) | `src/tools/FileReadTool/imageProcessor.ts:37` | `image-processor-napi` | `sharp` npm |
| 图片缩放 | `src/utils/imageResizer.ts` | 同上 | 同上 |

## 相关 skill

- [keybinding-handler-signature-alignment.md](keybinding-handler-signature-alignment.md) — native 路径的调用签名也必须对齐
- [image-paste-troubleshooting.md](image-paste-troubleshooting.md) — 图片粘贴链路中的 native 降级
- [binary-compile.md](binary-compile.md) — 编译时 `--external` 处理 native 模块
