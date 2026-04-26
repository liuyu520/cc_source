---
name: keybinding-handler-signature-alignment
description: 修复 keybinding 处理器调用签名不一致导致的参数丢失 bug 的通用方法
type: debugging
---

# Keybinding 处理器调用签名对齐

## 核心教训

**同一功能的多个触发路径（keybinding、paste handler、drag-drop）必须使用一致的函数签名，否则会导致参数丢失。**

这是从"ctrl+V 无法复制图片"bug 中吸取的真实教训。

## 反面案例（本次 bug）

### 问题表现

用户按 ctrl+V 粘贴图片后，输入框出现 `[Image #N]` 占位符，但图片无法正常渲染/提交。

### 根因定位

`src/components/PromptInput/PromptInput.tsx` 中存在**两条图片粘贴路径**：

1. **正常路径**（拖拽/bracketed paste）：`usePasteHandler` → `onImagePaste(base64, mediaType, filename, dimensions, sourcePath)`
2. **快捷键路径**（ctrl+V）：`handleImagePaste` → `onImagePaste(base64, mediaType)` ❌

```typescript
// ❌ 错误：快捷键路径只传了 2 个参数
const handleImagePaste = useCallback(() => {
  void getImageFromClipboard().then(imageData => {
    if (imageData) {
      onImagePaste(imageData.base64, imageData.mediaType);  // 丢失 dimensions!
    }
  });
}, [onImagePaste]);
```

**结果**：`PastedContent` 对象缺失 `dimensions` 字段，导致后续 `cacheImagePath()` / `storeImage()` 逻辑异常。

### 正面案例（修复后）

```typescript
// ✅ 正确：对齐 usePasteHandler 的完整签名
const handleImagePaste = useCallback(() => {
  void getImageFromClipboard().then(imageData => {
    if (imageData) {
      onImagePaste(
        imageData.base64,
        imageData.mediaType,
        undefined,              // 剪贴板图片没有 filename
        imageData.dimensions,   // 必须传递尺寸信息
      );
    }
  });
}, [onImagePaste]);
```

## 判断清单：在实施 keybinding 处理器时

1. **是否存在多条触发路径？** 检查同一功能是否有 keybinding、paste、drag-drop、右键菜单等多个入口。
2. **所有路径是否调用同一个核心函数？** 避免重复实现逻辑，应收敛到单一 handler。
3. **核心函数的参数是否完整传递？** 用 TypeScript 类型检查确保所有必需参数都有值（即使是 `undefined`）。
4. **可选参数的默认值是否一致？** 如果某些路径传 `undefined`，确保核心函数内部有正确的 fallback。

## 定位方法

### 1. 搜索关键函数的所有调用点

```bash
grep -rn "onImagePaste\|handleImagePaste" src/components/PromptInput/
```

找到所有调用 `onImagePaste` 的地方，对比参数个数。

### 2. 检查 keybinding 注册

```bash
grep -rn "chat:imagePaste" src/keybindings/ src/components/
```

确认 `chat:imagePaste` action 绑定到哪个 handler，该 handler 是否正确调用核心函数。

### 3. 对比正常路径与快捷键路径

- **正常路径**：`usePasteHandler.ts:66-75` 调用 `onImagePaste` 时传了 5 个参数
- **快捷键路径**：`PromptInput.tsx:1621-1623` 只传了 2 个参数 ❌

### 4. 验证修复

```bash
# 手动测试
1. 复制一张图片到剪贴板
2. 在 REPL 中按 ctrl+V
3. 确认输入框出现 [Image #N] 占位符
4. 提交消息，确认图片正常显示
```

## 可复用的检查模式

对于"多路径触发同一功能"的场景，在代码审查时可以复用以下检查清单：

```typescript
// 核心函数签名（作为 ground truth）
function onImagePaste(
  base64: string,
  mediaType?: string,
  filename?: string,
  dimensions?: ImageDimensions,
  sourcePath?: string,
) { /* ... */ }

// 检查点 1：usePasteHandler 路径
onImagePaste(
  imageData.base64,
  imageData.mediaType,
  undefined,
  imageData.dimensions,  // ✅ 必须传递
)

// 检查点 2：keybinding 路径
onImagePaste(
  imageData.base64,
  imageData.mediaType,
  undefined,
  imageData.dimensions,  // ✅ 必须传递
)

// 检查点 3：drag-drop 路径（如果有）
onImagePaste(
  imageData.base64,
  imageData.mediaType,
  filename,
  imageData.dimensions,  // ✅ 必须传递
  sourcePath,
)
```

## 通用原则

> 任何通过不同入口（keybinding、事件监听器、回调）触发的功能，都应该：
> 1. 收敛到同一个核心函数
> 2. 所有入口使用完全一致的参数列表（即使某些参数为 `undefined`）
> 3. 核心函数内部处理可选参数的默认值，而不是在调用方分散处理

## 关键代码位置

| 功能 | 文件 | 位置 |
|------|------|------|
| 核心处理函数 | `src/components/PromptInput/PromptInput.tsx` | `onImagePaste()` 函数定义 (L1151) |
| 快捷键处理器 | `src/components/PromptInput/PromptInput.tsx` | `handleImagePaste()` 回调 (L1620) |
| 正常粘贴路径 | `src/hooks/usePasteHandler.ts` | `checkClipboardForImageImpl()` (L63-87) |
| Keybinding 注册 | `src/keybindings/defaultBindings.ts` | `IMAGE_PASTE_KEY` 绑定 (L87) |
| Keybinding 解析 | `src/keybindings/resolver.ts` | `resolveKeyWithChordState()` |

## 相关 skill

- [fast-path-placement.md](fast-path-placement.md) — 快速路径优化的位置原则
- [input-auto-append.md](input-auto-append.md) — 用户输入预处理的通用模板
- [image-paste-troubleshooting.md](image-paste-troubleshooting.md) — 图片粘贴全链路排查

## 举一反三（可复用场景）

此模式适用于所有"多入口单功能"的场景：

1. **文件上传**：拖拽、点击按钮、粘贴路径 → 统一调用 `handleFileUpload(file, source)`
2. **模式切换**：快捷键、下拉菜单、命令行参数 → 统一调用 `setMode(mode, reason)`
3. **撤销/重做**：ctrl+Z、菜单项、工具栏按钮 → 统一调用 `undo()`
4. **提交消息**：Enter、ctrl+Enter、按钮点击 → 统一调用 `onSubmit(input, options)`

**禁止**为不同入口写重复逻辑——必须收敛到单一核心函数，并确保所有调用点参数一致。
