# 用户输入自动追加规则 (inputAutoAppend)

对非斜杠命令的普通用户输入，当长度超过阈值且不包含排除关键词时，自动在末尾追加一段指定文本（如"举一反三，触类旁通,尽可能复用已有逻辑"），以强化 Claude 的复用/泛化行为。所有参数外置到 `~/.claude/settings.json`。

## 工作原理

### 触发流程

```
用户输入 → processUserInput → 非 '/' 开头? → 读取 settings.inputAutoAppend
         → enabled && len>minLength && !includes(excludeKeyword) → 追加 appendText
         → 同步 normalizedInput 末尾 text block
```

### 实现位置

`src/utils/processUserInput/processUserInput.ts:577-606`

```ts
// 自动追加逻辑：根据 settings.json 中的 inputAutoAppend 配置，
// 当普通文本输入长度超过阈值且不包含排除关键词时，自动追加指定文本
if (inputString !== null && !inputString.startsWith('/')) {
  const settings = getInitialSettings()
  const autoAppend = settings.inputAutoAppend
  if (autoAppend?.enabled) {
    const minLen = autoAppend.minLength ?? 30
    const excludeKw = autoAppend.excludeKeyword ?? ''
    const appendText = autoAppend.appendText ?? ''
    if (
      appendText &&
      inputString.length > minLen &&
      (!excludeKw || !inputString.includes(excludeKw))
    ) {
      inputString = inputString + '  ' + appendText
      // 同步更新 normalizedInput（字符串 或 最后一个 text block）
      if (typeof normalizedInput === 'string') {
        normalizedInput = inputString
      } else if (normalizedInput.length > 0) {
        const lastBlock = normalizedInput[normalizedInput.length - 1]
        if (lastBlock?.type === 'text') {
          normalizedInput = [
            ...normalizedInput.slice(0, -1),
            { type: 'text' as const, text: inputString },
          ]
        }
      }
    }
  }
}
```

### Schema 注册

`src/utils/settings/types.ts:1072` 在全局 settings zod schema 中注册 `inputAutoAppend` 字段，使其能被 `getInitialSettings()` 正确解析与类型校验。

## 配置

`~/.claude/settings.json`：

```json
"inputAutoAppend": {
  "enabled": true,
  "minLength": 30,
  "excludeKeyword": "举一反三",
  "appendText": "举一反三，触类旁通,尽可能复用已有逻辑"
}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| enabled | false | 总开关 |
| minLength | 30 | 严格大于该长度才触发（`>`，非 `>=`）|
| excludeKeyword | '' | 输入包含此子串则跳过（避免重复追加）|
| appendText | '' | 要追加的文本；为空则跳过 |

## 设计要点

- **斜杠命令豁免**：`inputString.startsWith('/')` 直接跳过，避免污染 slash command 参数解析。
- **幂等性**：通过 `excludeKeyword` 判断是否已经含有追加内容，防止多轮对话重复堆叠。
- **双路径同步**：`inputString` 与 `normalizedInput`（可能是 string 或 message block 数组）必须同时更新，否则下游 API 发送的仍是原始内容。仅当末尾 block 为 `text` 时才替换，保留 image/attachment block。
- **复用已有入口**：挂在 `processUserInput` 现有流水线尾部（在 agent mention 日志之后、`addImageMetadataMessage` return 之前），不新增拦截器，不修改 REPL 层。
- **配置外置**：不写死字符数与文案，全部走 settings schema，用户可热改 `~/.claude/settings.json`。

## 举一反三（可复用模式）

此模式可作为"**基于 settings 的用户输入预处理**"通用模板，后续类似需求（例如：敏感词拦截、自动翻译、前缀注入、租户标签）都应：

1. 在 `src/utils/settings/types.ts` zod schema 中新增字段。
2. 在 `processUserInput.ts` 返回前插入逻辑分支，复用 `getInitialSettings()`。
3. 判定入口统一排除 `startsWith('/')` 的斜杠命令。
4. 同步更新 `inputString` + `normalizedInput` 两条路径。
5. 保持幂等（用关键词或 marker 判重）。

禁止为单次需求新建独立 hook/middleware 层——沿用此处即可。
