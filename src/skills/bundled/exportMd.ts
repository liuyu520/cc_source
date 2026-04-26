import { registerBundledSkill } from '../bundledSkills.js'

const EXPORT_MD_PROMPT = `# Export Conversation to Markdown

Export the current session's complete conversation history to a local Markdown file with full details.

## Usage

Run the \`/export-md\` slash command directly. It accepts an optional filename argument:

- \`/export-md\` — auto-generates a filename like \`2026-04-02-120000-topic.md\`
- \`/export-md my-session\` — saves as \`my-session.md\`
- \`/export-md notes.md\` — saves as \`notes.md\`

## Output Format

The exported Markdown includes:

1. **YAML Frontmatter** — title, export timestamp, message count
2. **User Messages** — full text content with timestamps
3. **Assistant Messages** — text responses, tool calls (formatted as JSON code blocks), thinking process (in collapsible \`<details>\` blocks)
4. **System Messages** — non-meta system messages with severity level
5. **Tool Use Summaries** — aggregated tool usage information
6. **Footer** — total user turn count

## Notes

- The file is saved to the current working directory
- Filename auto-generation reuses the existing \`/export\` command's logic (timestamp + sanitized first prompt)
- Progress messages and internal meta messages are excluded for cleanliness
- The command is a \`local\` type (non-interactive), so it writes directly without a dialog
`

export function registerExportMdSkill(): void {
  registerBundledSkill({
    name: 'export-md',
    description:
      'Export the current conversation to a Markdown file with full details including tool calls, thinking process, and timestamps.',
    aliases: ['exportmd'],
    userInvocable: true,
    disableModelInvocation: true,
    async getPromptForCommand(args) {
      let prompt = EXPORT_MD_PROMPT
      if (args) {
        prompt += `\n## Additional Instructions\n\n${args}`
      }
      return [{ type: 'text', text: prompt }]
    },
  })
}
