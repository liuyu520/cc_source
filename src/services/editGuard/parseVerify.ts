/**
 * EditGuard · Parse 验证层
 *
 * 对已落盘的文件进行语法 parse check,返回 {ok, reason?}。纯 I/O + parse,
 * 不写 evidence,不回滚。
 *
 * 支持的解析器(按文件扩展名路由):
 *   .json / .jsonc → JSON.parse(容忍尾逗号需要预处理,MVP 用原生 JSON.parse)
 *   .ts / .tsx / .js / .jsx / .mjs / .cjs → Bun.Transpiler.scan()
 *   其他扩展名 → pass(不验证,返回 ok:true)
 *
 * 设计约束:
 *   - fail-open:parse 内部抛错不算"文件坏",只当 "无法验证" 返回 ok:true
 *   - 禁止引入新依赖:只使用 bun 运行时内置的 Transpiler + 标准库 JSON
 *   - 非代码文件(.md/.txt/.sh/.yaml/...)默认跳过,避免误报
 */

import * as path from 'path'

export interface ParseVerifyResult {
  ok: boolean
  /** 当 ok=false 时的失败原因 */
  reason?: string
  /** 使用的解析器标识,用于 evidence 区分 */
  parser: 'json' | 'bun-transpiler' | 'skip'
}

/** 判断扩展名并返回 parser 类型 */
function chooseParser(filePath: string): ParseVerifyResult['parser'] {
  const ext = path.extname(filePath).toLowerCase()
  switch (ext) {
    case '.json':
    case '.jsonc':
      return 'json'
    case '.ts':
    case '.tsx':
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      return 'bun-transpiler'
    default:
      return 'skip'
  }
}

/** 检查内容是否是合法 JSON */
function verifyJson(content: string): ParseVerifyResult {
  try {
    JSON.parse(content)
    return { ok: true, parser: 'json' }
  } catch (err) {
    return {
      ok: false,
      reason: `JSON.parse failed: ${(err as Error).message}`,
      parser: 'json',
    }
  }
}

/** 检查内容是否能被 Bun.Transpiler 处理(ts/tsx/js/jsx) */
function verifyBunTranspile(
  content: string,
  ext: string,
): ParseVerifyResult {
  try {
    // Bun.Transpiler 是 Bun 运行时 API,production bundle 也保留。
    // 这里用 dynamic access 避免非 Bun 环境下 import-time 报错。
    const BunGlobal = (globalThis as unknown as {
      Bun?: {
        Transpiler?: new (opts: { loader: string }) => {
          scan: (code: string) => unknown
        }
      }
    }).Bun
    if (!BunGlobal?.Transpiler) {
      // 非 Bun 环境 → 跳过验证,返回 ok(fail-open)
      return { ok: true, parser: 'skip' }
    }
    const loader =
      ext === '.tsx'
        ? 'tsx'
        : ext === '.ts'
          ? 'ts'
          : ext === '.jsx'
            ? 'jsx'
            : 'js'
    const transpiler = new BunGlobal.Transpiler({ loader })
    // scan() 会解析代码并提取 imports/exports,语法错误会 throw
    transpiler.scan(content)
    return { ok: true, parser: 'bun-transpiler' }
  } catch (err) {
    return {
      ok: false,
      reason: `bun-transpiler scan failed: ${(err as Error).message}`,
      parser: 'bun-transpiler',
    }
  }
}

/**
 * 主入口:验证 filePath 在新 content 下能否 parse。
 * 不读磁盘,由调用方传入 content;由调用方决定 content 来源(刚写入 / 预写入)。
 */
export function verifyParse(
  filePath: string,
  content: string,
): ParseVerifyResult {
  const parser = chooseParser(filePath)
  if (parser === 'skip') {
    return { ok: true, parser: 'skip' }
  }
  if (parser === 'json') {
    return verifyJson(content)
  }
  if (parser === 'bun-transpiler') {
    const ext = path.extname(filePath).toLowerCase()
    return verifyBunTranspile(content, ext)
  }
  // 兜底,理论上不可达
  return { ok: true, parser: 'skip' }
}
