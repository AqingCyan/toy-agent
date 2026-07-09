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
 * 清理较早且可丢弃的工具输出，同时保留最近的工具上下文。
 *
 * @param messages - 待压缩的模型消息列表。
 * @returns 压缩结果，包含压缩后的消息列表和清理数量。
 */
export function microcompact(messages: ModelMessage[]): { messages: ModelMessage[], cleared: number } {
  let cleared = 0
  const toolResultIndices: number[] = [] // 找到所有 tool result 消息的位置

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.role === 'tool' && Array.isArray(msg.content)) {
      toolResultIndices.push(i)
    }
  }

  // 保留最近 N 个工具结果不动，只清理更早的
  const toClear = toolResultIndices.slice(0, Math.max(0, toolResultIndices.length - KEEP_RECENT_TOOL_RESULTS))

  const result = messages.map((msg, idx) => {
    // 保留清理窗口外的消息。
    if (!toClear.includes(idx)) {
      return msg
    }

    // 只处理结构化的工具消息。
    if (msg.role !== 'tool' || !Array.isArray(msg.content)) {
      return msg
    }

    // 只清理允许压缩的工具结果。
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
