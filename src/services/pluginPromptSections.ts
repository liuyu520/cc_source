/**
 * 插件系统提示段注册表
 *
 * 允许插件（builtin 和 marketplace）注册自定义 system prompt sections。
 * 注册的 section 通过 getPluginPromptSections() 返回，
 * 由 prompts.ts 的 getSystemPrompt() 在动态段中包含。
 *
 * 复用 systemPromptSection() 的缓存机制，每个插件 section 被包装为
 * 标准的 SystemPromptSection 对象，享受 resolveSystemPromptSections()
 * 的统一缓存和解析流程。
 */

import { systemPromptSection } from '../constants/systemPromptSections.js'

// SystemPromptSection 类型与 systemPromptSections.ts 一致
type ComputeFn = () => string | null | Promise<string | null>
type SystemPromptSection = {
  name: string
  compute: ComputeFn
  cacheBreak: boolean
}

/**
 * 插件提示段注册条目
 */
export type PluginSectionEntry = {
  /** 注册此 section 的插件名称 */
  pluginName: string
  /** section 唯一标识（会加 plugin_ 前缀避免与内置 section 冲突） */
  sectionName: string
  /** section 内容：静态字符串或动态计算函数 */
  content: string | (() => string | null)
}

// ── 模块级注册表 ─────────────────────────────────────────────

const registeredSections: PluginSectionEntry[] = []

// ── 公共 API ─────────────────────────────────────────────────

/**
 * 注册一个插件提示段。
 * 同一 pluginName + sectionName 组合重复注册时，后者覆盖前者。
 */
export function registerPluginPromptSection(entry: PluginSectionEntry): void {
  // 去重：同插件同名 section 只保留最新
  const existingIdx = registeredSections.findIndex(
    s => s.pluginName === entry.pluginName && s.sectionName === entry.sectionName,
  )
  if (existingIdx !== -1) {
    registeredSections[existingIdx] = entry
  } else {
    registeredSections.push(entry)
  }
}

/**
 * 移除指定插件的所有提示段（插件禁用时调用）
 */
export function removePluginPromptSections(pluginName: string): void {
  for (let i = registeredSections.length - 1; i >= 0; i--) {
    if (registeredSections[i].pluginName === pluginName) {
      registeredSections.splice(i, 1)
    }
  }
}

/**
 * 获取所有已注册的 SystemPromptSection 对象。
 * 供 prompts.ts 的 getSystemPrompt() 中 dynamicSections 数组消费，
 * 与内置 section 一起被 resolveSystemPromptSections() 处理。
 */
export function getPluginPromptSections(): SystemPromptSection[] {
  return registeredSections.map(entry => {
    // 加前缀避免与内置 section 命名冲突
    const name = `plugin_${entry.pluginName}_${entry.sectionName}`
    const compute: ComputeFn =
      typeof entry.content === 'function'
        ? entry.content
        : () => entry.content as string
    return systemPromptSection(name, compute)
  })
}

/**
 * 清空注册表（测试 / session 重置用）
 */
export function clearPluginPromptSections(): void {
  registeredSections.length = 0
}
