# 图片粘贴全链路排查指南

## 目标

当用户报告"粘贴图片不工作"时，按照本文档的链路从头到尾排查，定位到确切断点。本项目的图片粘贴涉及 5 个层次：按键解析 → keybinding 路由 → 剪贴板读取 → 图片处理 → UI 渲染。

## 链路概览

```
用户按键 (ctrl+V / Cmd+V / 拖拽)
  ↓
parse-keypress.ts  →  {name:'v', ctrl:true}  或  bracketed paste
  ↓
ChordInterceptor / useKeybindings  →  chat:imagePaste  action
  ↓
handleImagePaste()  →  getImageFromClipboard()
  ↓
Native NSPasteboard (darwin)  ──返回 null 时──>  «class furl» 文件路径回退
  ↓                                                ↓
osascript «class PNGf» (darwin) /xclip(linux)    读取磁盘图片字节
  ↓ checkImage 失败时也走 ──>  «class furl» 文件路径回退
  ↓
maybeResizeAndDownsampleImageBuffer()  ──失败时──>  resizeOrFallback() 降级返原 buffer
  ↓
onImagePaste(base64, mediaType, filename, dimensions, sourcePath)
  ↓
PastedContent → [Image #N] 占位 → cacheImagePath → storeImage
```

**关键设计要点**:
- **furl 回退层**:Finder/微信/QQ 等"复制图片文件"放进剪贴板的是 `«class furl»`(public.file-url),不是 PNGf 位图。两条主路径(native 和 osascript)在拿不到 PNGf 时都要尝试 furl,否则用户看到的会是误导性的"剪贴板没图片"。
- **resizeOrFallback 降级层**:Anthropic API 真正硬限制是 base64 5MB,2000×2000 是客户端为省 token 自加的优化阈值。resize 失败时只要 base64 在 5MB 内就用原 buffer,不要把整张能正常上传的图丢成 null。

## 逐层排查

### 第 1 层：按键解析

**文件**: `src/ink/parse-keypress.ts`

ctrl+V 在终端中发送 `\x16`（ASCII SYN）。在 parse-keypress.ts 的处理逻辑中：

```typescript
// L723: \x01 ~ \x1a → ctrl+a ~ ctrl+z
} else if (s <= '\x1a' && s.length === 1) {
  key.name = String.fromCharCode(s.charCodeAt(0) + 'a'.charCodeAt(0) - 1)
  key.ctrl = true
}
```

`\x16` → charCode 22 → 22 + 97 - 1 = 118 = `'v'` → `{name: 'v', ctrl: true}` ✅

**潜在问题**:
- 某些终端的 ctrl+V 会被截获为"字面量下一字符"（literal-next），不发送到 stdin
- CSI u / kitty 协议终端走不同分支 (L633)，但结果相同

### 第 2 层：Keybinding 路由

**文件**: `src/keybindings/defaultBindings.ts`, `src/keybindings/match.ts`

```typescript
// defaultBindings.ts:15
const IMAGE_PASTE_KEY = getPlatform() === 'windows' ? 'alt+v' : 'ctrl+v'

// defaultBindings.ts:87 (Chat context)
[IMAGE_PASTE_KEY]: 'chat:imagePaste',
```

匹配逻辑在 `match.ts:86-105`：
1. `getKeyName(input, key)` → 对 ctrl 修饰键，input-event.ts:58 已经把 input 转为 `key.name`（即 `'v'`）
2. `modifiersMatch()` → 检查 ctrl/shift/meta/super 是否与 target 一致

**潜在问题**:
- `isActive: !isModalOverlayActive` — 如果有模态弹窗覆盖，keybinding 不触发
- 其他 useInput 监听器先 `stopImmediatePropagation` 了事件（如 voice hold-to-talk）

### 第 3 层：剪贴板读取

**文件**: `src/utils/imagePaste.ts`

`getImageFromClipboard()` 有两条路径：

**快速路径（Native NSPasteboard，仅 darwin）**:
```typescript
if (feature('NATIVE_CLIPBOARD_IMAGE') && process.platform === 'darwin' && ...) {
  const { getNativeModule } = await import('image-processor-napi')
  const native = readClipboard(IMAGE_MAX_WIDTH, IMAGE_MAX_HEIGHT)
  if (!native) return null  // ← 注意：native 返回 null 是权威的"无图片"
}
```

**osascript 回退（darwin）/ xclip（linux）**:
```typescript
const checkResult = await execa(commands.checkImage, { shell: true })
if (checkResult.exitCode !== 0) return null  // 剪贴板没有图片
```

**潜在问题**:
- `image-processor-napi` 模块不存在时，`await import()` 抛 MODULE_NOT_FOUND → catch → 落到 osascript ✅
- 但如果模块存在但残缺（stub），`getNativeModule()` 返回有 `readClipboardImage` 但实现错误 → `native = null` → **直接 return null，不走 osascript 回退** ❌
- osascript 的 `«class PNGf»` 需要 UTF-8 编码，在某些 LC_CTYPE=C 的环境下可能失败
- Linux 需要 `xclip` 或 `wl-paste` 已安装

### 第 4 层：onImagePaste 调用签名

**文件**: `src/components/PromptInput/PromptInput.tsx`

**已修复的 bug**：`handleImagePaste` 只传 2 参数，丢失 `dimensions`。

对齐后所有路径必须传完整参数：
```typescript
onImagePaste(
  imageData.base64,
  imageData.mediaType,
  filename,           // undefined for clipboard
  imageData.dimensions,
  sourcePath,         // undefined for clipboard
)
```

**检查方法**:
```bash
grep -n "onImagePaste(" src/components/PromptInput/PromptInput.tsx src/hooks/usePasteHandler.ts
```

### 第 5 层：UI 渲染

**文件**: `src/components/PromptInput/PromptInput.tsx`

`onImagePaste()` 内部：
1. `cacheImagePath(newContent)` — 同步缓存路径
2. `storeImage(newContent)` — 异步写磁盘
3. `setPastedContents(prev => ({...prev, [pasteId]: newContent}))` — 更新 React 状态
4. `insertTextAtCursor(formatImageRef(pasteId))` — 插入 `[Image #N]` 占位

**潜在问题**:
- `cacheImagePath` 依赖 `dimensions` 计算缩略图路径？需确认
- `storeImage` 如果 base64 为空或 mediaType 错误，静默失败

## ⚠️ 重要陷阱:静默 catch 把第 4 层异常伪装成第 3 层症状

`imagePaste.ts` 的 osascript 路径外面包了一个 try/catch,**所有异常**(读文件失败、`maybeResizeAndDownsampleImageBuffer` 抛 `ImageResizeError`、`getImageProcessor()` 找不到 sharp)都会被吞成 `return null`,UI 上显示 **"No image found in clipboard"**——但**剪贴板里其实有图**。

这会让排查跑偏:用户和 AI 都以为是第 3 层(剪贴板检测)失败,实际是第 4 层(图片处理)炸了。

**典型触发条件**:
- restoration build 里 `sharp` 包没装 → resizer 内部任何 sharp 调用必抛错
- 图片任一边 > 2000px → resizer fallback 检测 overDim → 直接 `throw ImageResizeError`
- 两者叠加 → 任何超 2000px 的截图都会被静默吞成 "剪贴板没图片"

**诊断方法**:用 `bun -e` 直接调用 `getImageFromClipboard()`,如果返回 NULL 但 `osascript -e 'clipboard info'` 显示有 PNGf,就是这个陷阱。然后分步跑 checkImage / saveImage / readFile / resize,看哪一步抛错。

**修法**:catch 里至少 `logError`,不要静默吞;并对 `ImageResizeError` 做降级——只要 base64 在 5MB 内就直接返回原 buffer(2000×2000 是客户端 token 优化,不是 API 硬限制)。已在 `getImageFromClipboard` 里通过 `resizeOrFallback()` 实现。

## 快速诊断决策树

```
ctrl+V 无反应?
├─ 终端是否吞了 ctrl+V? → 检查终端设置（literal-next 模式）
├─ 有模态弹窗覆盖? → isModalOverlayActive = true → keybinding 不触发
├─ voice hold-to-talk 拦截? → 检查 voiceKeystroke 设置
└─ keybinding 触发了但无效果?
   ├─ "No image in clipboard" 通知? → 剪贴板确实没图片
   ├─ 无任何通知? → getImageFromClipboard 抛异常（unhandled rejection）
   └─ [Image #N] 出现但无法显示?
      ├─ dimensions 缺失? → 调用签名不一致（本次 bug）
      └─ storeImage 失败? → base64/mediaType 异常
```

## Cmd+V vs ctrl+V（macOS 特有）

| 按键 | 终端行为 | 代码路径 |
|------|---------|---------|
| **Cmd+V** | 发送 bracketed paste（`ESC[200~...ESC[201~`）| `usePasteHandler` → `isFromPaste=true` → 空粘贴走 `checkClipboardForImage()` |
| **ctrl+V** | 发送 `\x16`（raw byte）| `useKeybindings` → `chat:imagePaste` → `handleImagePaste()` |

两条路径最终都调用 `getImageFromClipboard()`，但入口不同。Cmd+V 走 usePasteHandler（L245），ctrl+V 走 useKeybindings（L1620）。

## hasImageInClipboard 的平台限制

```typescript
// imagePaste.ts:96-98
export async function hasImageInClipboard(): Promise<boolean> {
  if (process.platform !== 'darwin') {
    return false  // ← Linux/Windows 永远返回 false！
  }
  // ...
}
```

这意味着 Linux/Windows 上**不会显示 "Image in clipboard" 提示**（useClipboardImageHint），但 ctrl+V 仍然可以触发粘贴（走 `getImageFromClipboard` 而非 `hasImageInClipboard`）。

## 关键代码位置

| 功能 | 文件 | 入口 |
|------|------|------|
| 按键解析 | `src/ink/parse-keypress.ts` | `parseKeypress()` L611 |
| input 事件转换 | `src/ink/events/input-event.ts` | L58 |
| Keybinding 绑定 | `src/keybindings/defaultBindings.ts` | `IMAGE_PASTE_KEY` L15, L87 |
| Keybinding 匹配 | `src/keybindings/match.ts` | `matchesKeystroke()` L86 |
| Keybinding 分发 | `src/keybindings/useKeybinding.ts` | `useKeybindings()` L113 |
| Chord 拦截器 | `src/keybindings/KeybindingProviderSetup.tsx` | `ChordInterceptor` L226 |
| ctrl+V handler | `src/components/PromptInput/PromptInput.tsx` | `handleImagePaste()` L1620 |
| Cmd+V handler | `src/hooks/usePasteHandler.ts` | `wrappedOnInput()` L214, L245 |
| 剪贴板读取 | `src/utils/imagePaste.ts` | `getImageFromClipboard()` L124 |
| 剪贴板检测 | `src/utils/imagePaste.ts` | `hasImageInClipboard()` L96 |
| 图片处理 | `src/utils/imageResizer.ts` | `maybeResizeAndDownsampleImageBuffer()` |
| UI 渲染 | `src/components/PromptInput/PromptInput.tsx` | `onImagePaste()` L1151 |

## 相关 skill

- [keybinding-handler-signature-alignment.md](keybinding-handler-signature-alignment.md) — 多入口单功能的签名对齐原则
- [fast-path-placement.md](fast-path-placement.md) — native 快速路径 vs osascript 回退的位置关系
- [native-fallback-chain.md](native-fallback-chain.md) — native 模块降级与回退链模式
