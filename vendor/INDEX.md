# `vendor/` 模块索引

## 目录定位

`vendor/` 保存少量恢复出来的原生/辅助模块源码占位实现，通常与 `shims/` 中的本地包一一对应。

## 目录清单

| 目录 | 说明 |
| --- | --- |
| `audio-capture-src/` | 音频采集源码占位 |
| `image-processor-src/` | 图像处理源码占位 |
| `modifiers-napi-src/` | 修饰键原生模块源码占位 |
| `url-handler-src/` | URL handler 原生模块源码占位 |

## 使用方式

- `vendor/` 更像恢复材料或源码参考，不是直接对外暴露的运行时接口
- 真正被依赖图消费的通常是 [../shims/INDEX.md](../shims/INDEX.md) 下的包
- 如果需要修复 native 缺失链路，优先确认 `vendor/` 与 `shims/` 是否同步

## 关联模块

- 兼容包： [../shims/INDEX.md](../shims/INDEX.md)
- 语音/图像等调用方： [../src/services/INDEX.md](../src/services/INDEX.md)、[../src/utils/INDEX.md](../src/utils/INDEX.md)
