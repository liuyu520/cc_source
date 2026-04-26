# `src/constants/` 模块索引

## 模块定位

`src/constants/` 存放系统级共享常量、限制、提示词片段、产品配置和 XML 标签。很多文件会被 `main.tsx`、`commands.ts`、`tools.ts`、`services/` 与 `utils/` 广泛引用。

## 关键文件

- `prompts.ts`
  系统提示词组装主入口
- `systemPromptSections.ts`
  系统提示词分片与缓存边界
- `tools.ts`
  工具分组与允许/禁止清单
- `oauth.ts`
  OAuth 常量
- `product.ts`
  产品 URL、远程会话地址等
- `xml.ts`
  task/tool 相关 XML tag 常量

## 其他常用常量

- `apiLimits.ts`
- `betas.ts`
- `files.ts`
- `messages.ts`
- `outputStyles.ts`
- `querySource.ts`
- `spinnerVerbs.ts`
- `turnCompletionVerbs.ts`

## 设计提示

- 这里的改动影响面往往很广，尤其是 `prompts.ts`、`tools.ts`、`xml.ts`
- 提示词与系统边界经常与 provider 能力、缓存策略和工具注册联动

## 关联模块

- 启动与系统提示： [../entrypoints/INDEX.md](../entrypoints/INDEX.md)
- 工具系统： [../tools/INDEX.md](../tools/INDEX.md)
- 服务层： [../services/INDEX.md](../services/INDEX.md)
