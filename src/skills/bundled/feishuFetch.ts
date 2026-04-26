import { registerBundledSkill } from '../bundledSkills.js'

// /feishu-fetch —— 飞书/Lark 文档抓取路由 skill
// 遇到 feishu.cn / larksuite.com URL 时走本地 lark-cli + lark-* skill,
// 而不是 WebFetch(WebFetch 会被域名安全策略拒绝,且无法处理 OAuth)。
// 与 codex.ts 相同的单文件内联 prompt 风格。
const FEISHU_FETCH_PROMPT = `# /feishu-fetch —— 飞书/Lark 文档路由

遇到 \`*.feishu.cn\` 或 \`*.larksuite.com\` 的 URL 时,**禁止**尝试 WebFetch,直接路由到本机已安装并鉴权的 \`lark-cli\` + \`lark-*\` skill。

## 触发场景

- 用户贴出 \`https://xxx.feishu.cn/...\` 或 \`https://xxx.larksuite.com/...\` 的链接
- 用户说"读取飞书文档/表格/知识库"、"下载飞书素材"、"导出飞书文档为 Markdown"等
- WebFetch 返回 "Unable to verify if domain is safe" 且域名属于飞书/Lark

## 路由表

| URL 片段 | Skill | 入口命令 |
|---|---|---|
| \`/docx/\` \`/doc/\` | \`lark-doc\` | \`lark-cli docs +fetch --doc <URL>\` (URL token 就是 file_token) |
| \`/wiki/\` | \`lark-wiki\` | 先 \`wiki.spaces.get_node\` 拿 \`obj_type\` + \`obj_token\`,再按类型分发 |
| \`/sheets/\` | \`lark-sheets\` | 电子表格读写 |
| \`/base/\` | \`lark-base\` | 多维表格 |
| \`/drive/folder/\` | \`lark-drive\` | 云空间文件夹 |
| docx 内 \`<image token="…"/>\` \`<file token="…"/>\` \`<whiteboard token="…"/>\` | \`lark-doc\` | 预览: \`docs +media-preview\`;下载: \`docs +media-download\` |

## 执行流程

1. **识别 URL 类型**:解析 hostname + path,匹配上表。
2. **调用 Skill 工具**:用 Skill(name=<对应 skill>) 让对应 skill 接管。
3. **输出落盘**:\`docs +fetch --format json\` 的 stdout 常常 >80KB,落到 tool-result 文件。通过 \`bun -e\` 或 \`jq\` 读取文件,提取 \`data.markdown\` 字段写到本地 \`.md\`。
4. **完整性校验**:
   - \`data.length\` 是含 \`<lark-table>\` \`<mention-doc>\` \`<image>\` 等标签的原始 Markdown 字节数
   - \`data.total_length\` 是去标签后的纯文本长度
   - \`length > total_length\` 属正常,不代表截断
   - 查 \`has_more\`;若为 true 用 \`--offset\` + \`--limit\` 分页
5. **后置处理(按需)**:
   - 素材图片:提取 \`<image token=…/>\` 中 token,批量 \`docs +media-download\`
   - 子文档引用:遇 \`<mention-doc token=… type="…">\`,按用户意愿递归拉取
   - 清洗标签:转通用 Markdown 时需把 \`<lark-table>\` 转成标准 \`| a | b |\` 表格

## Wiki URL 特殊处理(关键)

\`/wiki/\` 链接背后可能是 docx / sheet / bitable / slides 等任意类型,**不能直接把 URL token 当 file_token 用**:

\`\`\`bash
lark-cli wiki spaces get_node --params '{"token":"<wiki_token>"}'
# 从返回的 node.obj_type + node.obj_token 分发
\`\`\`

## 为什么这样做(Why)

- WebFetch 对 feishu.cn 直接返回 "Unable to verify if domain is safe" —— 这是产品级安全策略,不要绕过
- 飞书文档绝大多数需要 OAuth,WebFetch 拿不到鉴权 cookie
- \`lark-cli\` 已装在 \`/opt/homebrew/bin/lark-cli\`,并以用户身份 \`auth login\` 过 —— 这就是"尽可能复用已有逻辑"的正解
- \`~/.claude/skills/\` 下所有 \`lark-*\` 都是 symlink 到包管理目录,**不要编辑**,用 Skill 工具调用即可

## 触类旁通

同样的路由原则适用于其他鉴权平台:如果 \`~/.claude/skills/\` 下有对应平台的 skill(如未来出现的 google-docs / notion / confluence),优先走 skill;\`WebFetch\` 只保留给真正公开无鉴权的 URL。

## 注意

- **不要在本项目仓库里重新实现飞书 API 调用** —— 这是 Claude Code 重建源码树,不是飞书工具链
- 最终交付的 Markdown 默认保留飞书扩展标签(\`<lark-table>\` 等);如用户要求"通用 Markdown"再清洗
- 如果用户还没 \`auth login\` 或缺 scope,按 \`lark-shared\` skill 的 "Agent 代理发起认证" 章节处理,不要硬报错退出
`

export function registerFeishuFetchSkill(): void {
  registerBundledSkill({
    name: 'feishu-fetch',
    description:
      'Route Feishu/Lark URLs (feishu.cn / larksuite.com) to the local lark-cli + lark-* skills instead of WebFetch. Handles docx / wiki / sheets / base / drive / media.',
    aliases: ['lark-fetch', 'lark-route', 'feishu'],
    argumentHint: '<feishu URL or hint>',
    userInvocable: true,
    async getPromptForCommand(args) {
      let prompt = FEISHU_FETCH_PROMPT
      if (args) {
        prompt += `\n## 用户指定的 URL 或需求\n\n${args}\n`
      }
      return [{ type: 'text', text: prompt }]
    },
  })
}
