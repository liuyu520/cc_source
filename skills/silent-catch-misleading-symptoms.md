# 静默 catch 把深层异常伪装成浅层症状(反模式与诊断)

## 适用场景

当 UI 上看到的错误信息和"代码里实际抛出的位置"对不上时,优先怀疑这条链路上有 `catch {}` / `catch (e) { return null }` / `catch (e) { return false }` 在静默吞异常,把深层炸点伪装成浅层"什么都没发生"。

这类 bug 的特征:
- **现象明确,但和代码逻辑对不上**:用户说"剪贴板没图片",但 `osascript -e 'clipboard info'` 明明显示有 PNGf
- **复现稳定,但日志里什么都没有**:没有 stack trace,没有 logError,只有"功能不工作"
- **修改浅层代码无效**:你改了第一层(剪贴板检测),第二层(权限),第三层(命令拼接),依然失败,因为真凶在第四层
- **AI 和人都会跑偏**:症状信息把所有人引导去查错的层次

## 真实案例:ctrl+V 粘贴图片

UI 上提示:`No image found in clipboard`

按 5 层链路排查 → 第 1/2/3 层全部正常(剪贴板里有 192KB PNGf,osascript 检测通过,文件能写到磁盘)→ 但 `getImageFromClipboard()` 返回 null。

**真凶在第 4 层**:`maybeResizeAndDownsampleImageBuffer` 抛出 `ImageResizeError`(图片 2238×1200 超过 2000 硬限制,且 sharp 包未装),而 `getImageFromClipboard` 外面包了一个:

```typescript
} catch {
  return null   // ← 任何深层异常都被吞成"剪贴板没图"
}
```

第 4 层的"图太大处理失败"被伪装成第 3 层的"剪贴板没图片"。用户和 AI 都会跑偏 1 个小时去查剪贴板。

## 诊断方法:分步绕过 catch 跑

不要在外层加日志(可能影响业务流),写一个一次性脚本**跳过外层 catch,逐步调用每个内部函数**,看哪一步抛错:

```bash
bun -e "
const { execa } = await import('execa');
const path = '/tmp/screenshot.png';

console.log('--- step 1: checkImage ---');
const c = await execa(\`osascript -e '...'\`, { shell: true, reject: false });
console.log('exit:', c.exitCode, 'stderr:', c.stderr);

console.log('--- step 2: saveImage ---');
const s = await execa(\`...\`, { shell: true, reject: false });
console.log('exit:', s.exitCode, 'stderr:', s.stderr);

console.log('--- step 3: file on disk ---');
const fs = await import('fs');
console.log('exists:', fs.existsSync(path));

console.log('--- step 4: critical step ---');
try {
  const r = await suspectFunction(...);
  console.log('ok:', r);
} catch(e) {
  console.log('ERR:', e.message, e.stack);
}
"
```

每一步都打印 exit code / stderr / stack。**炸点会自己暴露**。

## 通用修法:三件套

### 1. 把静默 catch 改成 logError

```typescript
// ❌ Before
} catch {
  return null
}

// ✅ After
} catch (e) {
  logError(e as Error)  // 至少留下证据
  return null
}
```

成本几乎为零。下次出问题时,排查者能在日志里立刻看到真正的异常。

### 2. 区分"业务上的 null"和"异常上的 null"

```typescript
// ❌ Before: 调用方无法分辨
async function getX(): Promise<X | null>

// ✅ After: 至少在日志/通知层面区分
async function getX(): Promise<X | null> {
  try {
    // 业务上的 null:确实没有 → 静默 return null
    if (!hasX()) return null
    // ...
  } catch (e) {
    // 异常上的 null:出错了 → 必须日志
    logError(e)
    return null
  }
}
```

### 3. 对"硬限制 vs 软限制"做降级

很多深层异常其实是**客户端为优化自加的硬阻断**,而非业务硬要求。比如:

- 客户端"为省 token"把图片限制到 2000×2000,但 API 实际接受更大图
- 客户端"为防超时"把请求限制到 30s,但服务端实际允许 60s
- 客户端"为防滥用"把单次粘贴限制到 800 字符,但模型实际能吃更多

这种限制如果在中间层抛错,应该在外层做**降级**,而不是把整个功能丢成 null:

```typescript
async function resizeOrFallback(buffer) {
  try {
    return await maybeResizeAndDownsampleImageBuffer(buffer, ...)
  } catch (e) {
    logError(e)
    // 降级:只要原始 base64 在真正的 API 5MB 硬限制内,就用原 buffer
    const base64Size = Math.ceil((buffer.length * 4) / 3)
    if (base64Size <= 5 * 1024 * 1024) {
      return { buffer, mediaType: 'png' }
    }
    return null  // 真正超过 API 硬限制才放弃
  }
}
```

## 触类旁通

这个反模式不是 imagePaste 独有的。在 restoration 项目里,因为大量模块是 stub / 缺失依赖,**任何包了 try/catch 的"返回 null/false"函数都可能踩同一个坑**。建议优先排查:

| 高危位置 | 表象 | 真凶可能在 |
|---|---|---|
| 剪贴板/图片处理 | "剪贴板没内容" | sharp 缺失 / resize 抛 overDim |
| MCP 服务发现 | "未找到 MCP server" | 模块加载失败 / 协议解析失败 |
| 模型路由 | "未找到模型" | 第三方 base URL 检测失败 / SDK 客户端创建失败 |
| 文件读取 | "文件不存在" | fs 实现 stub / 权限错误 |
| 命令执行 | "命令失败" | shell 转义错 / PATH 解析错 |
| 配置加载 | "默认值生效了" | JSON parse 失败 / fastjson 行为差异 |
| Ink 渲染 | "REPL entered restored fallback mode" | reconciler 校验 throw 被 ErrorBoundary 吞掉,间歇性 `<Box>` 嵌套在 `<Text>` 内 |

只要看到"功能静默失效 + 复现稳定 + 日志没东西",**第一反应**就是: 这条链路上有静默 catch,先去找它,再去查真凶。

## 检查清单(写新代码时)

- [ ] 我的 try 块外面是不是吞掉了所有异常?
- [ ] catch 里有没有 logError(或类似日志机制)?
- [ ] 我返回 null / false 的语义,调用方能不能区分"业务 null"和"异常 null"?
- [ ] 如果异常来自客户端自加的硬限制,有没有做降级而不是直接丢?
- [ ] 用户最终看到的错误信息,会不会把他们引导到错误的排查方向?

## 相关 skill

- [image-paste-troubleshooting.md](image-paste-troubleshooting.md) — 这个反模式的真实案例(第 4 层伪装成第 3 层)
- [native-fallback-chain.md](native-fallback-chain.md) — native → 回退的"权威 null"陷阱(同样会吞掉降级机会)
- [fast-path-placement.md](fast-path-placement.md) — 快速路径"权威 return null"绕过回退的位置陷阱
