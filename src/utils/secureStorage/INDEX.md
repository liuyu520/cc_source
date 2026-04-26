# `src/utils/secureStorage/` 模块索引

## 模块定位

`src/utils/secureStorage/` 负责敏感凭据存储抽象，优先使用 macOS keychain，并在需要时回退到纯文本存储。

## 关键文件

- `index.ts`
  根据平台选择 secure storage 实现
- `macOsKeychainStorage.ts`
  macOS keychain 存储
- `macOsKeychainHelpers.ts`
  keychain 辅助函数
- `keychainPrefetch.ts`
  启动时预取

## 其他文件

- `fallbackStorage.ts`
- `plainTextStorage.ts`
- `types.ts`

## 关联模块

- 认证： [../INDEX.md](../INDEX.md)
- 设置与 OAuth： [../settings/INDEX.md](../settings/INDEX.md)
