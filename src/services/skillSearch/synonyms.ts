// src/services/skillSearch/synonyms.ts
// 中英双向同义词映射，用于skill搜索查询扩展

const SYNONYM_GROUPS: string[][] = [
  ['review', 'check', 'audit', '审查', '检查', '审核', '审阅'],
  ['debug', 'troubleshoot', 'fix', '调试', '排错', '修复', '排查'],
  ['test', 'tdd', '测试', '单元测试', '单测'],
  ['create', 'build', 'make', 'scaffold', 'new', '创建', '构建', '搭建', '新建'],
  ['plan', 'design', 'architect', '规划', '设计', '架构', '方案'],
  ['commit', 'push', 'merge', '提交', '推送', '合并'],
  ['frontend', 'ui', 'component', 'page', '前端', '界面', '组件', '页面'],
  ['refactor', 'cleanup', 'simplify', '重构', '清理', '简化', '优化'],
  ['deploy', 'release', 'publish', '部署', '发布', '上线'],
  ['security', 'vulnerability', 'auth', '安全', '漏洞', '认证', '鉴权'],
  ['document', 'docs', 'readme', '文档', '说明'],
  ['api', 'endpoint', 'route', '接口', '端点', '路由'],
  ['database', 'db', 'migration', 'sql', '数据库', '迁移'],
  ['style', 'css', 'theme', '样式', '主题', '皮肤'],
  ['performance', 'optimize', 'perf', '性能', '优化', '加速'],
]

// 构建反向索引: term → Set<所有同义词>
const synonymIndex = new Map<string, Set<string>>()
for (const group of SYNONYM_GROUPS) {
  const allTerms = new Set(group.map(t => t.toLowerCase()))
  for (const term of group) {
    synonymIndex.set(term.toLowerCase(), allTerms)
  }
}

/**
 * 将查询词列表通过同义词表扩展，返回包含原始词和所有同义词的列表
 */
export function expandWithSynonyms(terms: string[]): string[] {
  const expanded = new Set(terms)
  for (const term of terms) {
    const synonyms = synonymIndex.get(term.toLowerCase())
    if (synonyms) {
      for (const syn of synonyms) expanded.add(syn)
    }
  }
  return [...expanded]
}
