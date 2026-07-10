import type { ModelMessage } from 'ai'

const CLEARABLE_TOOLS = new Set([
  'read_file',
  'bash',
  'grep',
  'glob',
  'list_directory',
  'edit_file',
  'write_file',
])
const KEEP_RECENT_TOOL_RESULTS = 3

/**
 * 清理较早的工具消息，同时保留最近三条结构化工具消息。
 * 是否清理由首个内容块的工具名决定；命中白名单后会替换该消息中所有内容块的输出。
 *
 * @param messages - 待压缩的模型消息列表。
 * @returns 新的消息列表，以及被清理的工具消息数量。
 */
export function microcompact(messages: ModelMessage[]): { messages: ModelMessage[], cleared: number } {
  let cleared = 0
  const toolResultIndices: number[] = []

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.role === 'tool' && Array.isArray(msg.content)) {
      toolResultIndices.push(i)
    }
  }

  const toClear = toolResultIndices.slice(0, Math.max(0, toolResultIndices.length - KEEP_RECENT_TOOL_RESULTS))

  const result = messages.map((msg, idx) => {
    if (!toClear.includes(idx)) {
      return msg
    }

    if (msg.role !== 'tool' || !Array.isArray(msg.content)) {
      return msg
    }

    // 一个工具消息可能包含多个 part；当前以首个 part 的工具名判断整条消息是否可清理。
    const toolName = (msg.content[0] as any)?.toolName || 'unknown'
    if (!CLEARABLE_TOOLS.has(toolName)) {
      return msg
    }

    cleared++
    return {
      ...msg,
      content: msg.content.map((part: any) => ({
        ...part,
        output: '[tool result cleared]',
      })),
    }
  })

  return { messages: result, cleared }
}
