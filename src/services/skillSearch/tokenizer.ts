// src/services/skillSearch/tokenizer.ts
// 共享分词模块：CJK (Intl.Segmenter) + 英文空格分词 + TF-IDF 向量计算
// 被 localSearch.ts (skill搜索) 和 vectorIndex.ts (记忆向量索引) 共同使用

// CJK分词器：优先使用Intl.Segmenter进行语义分词
const segmenter =
  typeof Intl !== 'undefined' && Intl.Segmenter
    ? new Intl.Segmenter('zh-Hans', { granularity: 'word' })
    : null

// 中英文停用词表
const STOP_WORDS = new Set([
  // 英文
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from',
  'has', 'he', 'in', 'is', 'it', 'its', 'of', 'on', 'or', 'that',
  'the', 'to', 'was', 'were', 'will', 'with',
  // 常见编程上下文停用词
  'code', 'help', 'i', 'my', 'please', 'repo', 'use', 'want',
  // 中文停用词
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人',
  '都', '一', '一个', '上', '也', '很', '到', '说', '要', '去',
  '你', '会', '着', '没有', '看', '好', '自己', '这',
])

/**
 * 文本标准化：小写 + 去除特殊字符
 */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s/_-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 通用分词：中英文混合文本分词
 * - 英文：空格分词 + 停用词过滤
 * - CJK：Intl.Segmenter 语义分词，降级到 bigram
 */
export function tokenize(text: string): string[] {
  const normalized = normalize(text)
  if (!normalized) return []

  const terms: string[] = []

  // 英文：空格分词 + 停用词过滤
  for (const word of normalized.split(' ')) {
    if (word.length >= 2 && !STOP_WORDS.has(word)) {
      terms.push(word)
    }
  }

  // CJK：提取CJK文本
  const cjkText = normalized
    .replace(
      /[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu,
      ' ',
    )
    .trim()

  if (cjkText.length >= 2) {
    if (segmenter) {
      // Intl.Segmenter 语义分词
      for (const { segment, isWordLike } of segmenter.segment(cjkText)) {
        if (isWordLike && segment.length >= 2 && !STOP_WORDS.has(segment)) {
          terms.push(segment)
        }
      }
    } else {
      // 降级：bigram（兼容旧运行时）
      const hanOnly = normalized.replace(/[^\p{Script=Han}]+/gu, '')
      if (hanOnly.length >= 2) {
        terms.push(hanOnly)
        if (hanOnly.length > 4) {
          for (let i = 0; i < hanOnly.length - 1; i++) {
            terms.push(hanOnly.slice(i, i + 2))
          }
        }
      }
    }
  }

  return terms
}

/**
 * 计算词频 (TF)：归一化到文档长度
 */
export function computeTF(terms: string[]): Record<string, number> {
  if (terms.length === 0) return {}
  const freq: Record<string, number> = {}
  for (const term of terms) {
    freq[term] = (freq[term] ?? 0) + 1
  }
  const total = terms.length
  const tf: Record<string, number> = {}
  for (const [term, count] of Object.entries(freq)) {
    tf[term] = count / total
  }
  return tf
}

/**
 * 计算 TF-IDF 向量
 * @param terms 文档分词结果
 * @param idfMap 全局 IDF 值映射
 * @returns 稀疏向量 { term: tfidf_weight }
 */
export function computeTfIdf(
  terms: string[],
  idfMap: Record<string, number>,
): Record<string, number> {
  const tf = computeTF(terms)
  const vector: Record<string, number> = {}
  for (const [term, tfVal] of Object.entries(tf)) {
    // 如果 IDF 没有该词，使用默认值 1.0（新词在当前语料中不存在）
    vector[term] = tfVal * (idfMap[term] ?? 1.0)
  }
  return vector
}

/**
 * 稀疏向量余弦相似度
 * 遍历较小向量求点积，分别计算两个向量的模
 */
export function cosineSimilarity(
  a: Record<string, number>,
  b: Record<string, number>,
): number {
  let dotProduct = 0
  let normA = 0
  let normB = 0

  for (const val of Object.values(a)) {
    normA += val * val
  }
  for (const val of Object.values(b)) {
    normB += val * val
  }

  // 遍历较小的向量求点积
  const [smaller, larger] =
    Object.keys(a).length <= Object.keys(b).length ? [a, b] : [b, a]
  for (const [term, val] of Object.entries(smaller)) {
    if (term in larger) {
      dotProduct += val * larger[term]!
    }
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB)
  return denominator === 0 ? 0 : dotProduct / denominator
}
