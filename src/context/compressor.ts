import type { ModelMessage } from 'ai'
import { generateText } from 'ai'

/**
 * 按消息中的文本和工具输出字符数粗略估算上下文 Token 数。
 * 该估算使用“四个字符约等于一个 Token”的规则，并忽略无法识别的内容块。
 *
 * @param messages - 要估算的模型消息列表。
 * @returns 向上取整后的 Token 估算值。
 * @throws 工具输出无法通过 `JSON.stringify` 序列化时抛出错误。
 */
function estimateTokens(messages: ModelMessage[]): number {
  let chats = 0
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      chats += msg.content.length
    }
    else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if ('text' in part && typeof part.text === 'string') {
          chats += part.text.length
        }
        else if ('output' in part) {
          chats += JSON.stringify(part.output).length
        }
      }
    }
  }

  return Math.ceil(chats / 4)
}

/** 允许在较早消息中丢弃输出正文的工具名称。 */
const CLEARABLE_TOOLS = new Set([
  'read_file',
  'bash',
  'grep',
  'glob',
  'list_directory',
  'edit_file',
  'write_file',
  'web_search',
  'get_weather',
])
/** 微压缩时原样保留的最近结构化工具消息数量。 */
const KEEP_RECENT_TOOL_RESULTS = 3

/**
 * 清理较早的工具消息，同时保留最近三条结构化工具消息。
 * 是否清理由首个内容块的工具名决定；命中白名单后会替换该消息中所有内容块的输出。
 *
 * @param messages - 待压缩的模型消息列表。
 * @returns 新的消息列表，以及被清理的工具消息数量。
 */
export function microCompact(messages: ModelMessage[]): { messages: ModelMessage[], cleared: number } {
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

/** 约束摘要结构、语言、关键标识符和长度的系统提示。 */
const COMPRESS_PROMPT = `你是一个对话压缩系统。你的任务是把 Agent 和用户之间的对话历史压缩成一份结构化摘要，确保后续对话能够无缝继续。

请严格按照以下模板输出，每个字段都要填写。如果某个字段没有相关内容，写"无"：

## 用户意图
（用户在这次对话中想要完成什么）

## 已完成的操作
（Agent 执行了哪些工具调用、产生了什么结果）

## 关键发现
（读取的文件内容要点、搜索结果、命令输出中的关键信息）

## 当前状态
（对话进行到哪一步了、还有什么没做完）

## 需要保留的细节
（文件路径、变量名、配置值、错误信息等不能丢失的具体内容）

注意事项：
- 用对话中使用的语言（中文或英文）输出
- 文件路径、UUID、版本号等标识符必须原样保留，不要翻译或改写
- 不要写笼统的概述，只保留具体的、可操作的信息
- 总长度控制在 800 字以内`

/** 计划原样保留的最近消息数；实际边界会向前对齐到用户消息。 */
const KEEP_RECENT_MESSAGES = 6
/** 用于识别已注入模型上下文的历史摘要消息前缀。 */
const SUMMARY_MESSAGE_PREFIX = '[以下是之前对话的压缩摘要]'

/** LLM 摘要压缩后的上下文、摘要文本和替换计数。 */
export interface CompressionResult {
  /** 可继续传给模型的消息列表。 */
  messages: ModelMessage[]
  /** 最新摘要；未压缩或压缩失败时保留已有摘要。 */
  summary: string
  /** 本次被摘要替换的原始消息数量。 */
  compressedCount: number
}

/**
 * 摘要较早消息，并保留最近一段完整对话。
 * 是否达到业务压缩阈值由调用方决定；本函数只处理压缩边界和摘要生成。
 * 压缩边界会向前对齐到用户消息，避免从 assistant 或 tool 消息中间截断对话轮次。
 * 摘要模型调用失败时会记录错误并返回原始消息。
 *
 * @param model - 传给 AI SDK `generateText` 的语言模型实例。
 * @param messages - 待检查和压缩的完整消息列表。
 * @param existingSummary - 上一次压缩得到的摘要，用于增量合并历史上下文。
 * @returns 压缩后的消息和摘要；没有可摘要的较早轮次或摘要失败时 `compressedCount` 为零。
 * @throws 消息内容在摘要文本组装阶段无法序列化时抛出错误。
 */
export async function summarize(model: any, messages: ModelMessage[], existingSummary?: string): Promise<CompressionResult> {
  if (messages.length <= KEEP_RECENT_MESSAGES) {
    return { messages, summary: existingSummary || '', compressedCount: 0 }
  }

  const splitIndex = Math.max(0, messages.length - KEEP_RECENT_MESSAGES)

  // 从用户消息开始保留，避免留下缺少调用上下文的 assistant/tool 消息。
  let alignedIdx = splitIndex
  while (alignedIdx > 0 && messages[alignedIdx].role !== 'user') {
    alignedIdx--
  }
  if (alignedIdx === 0) {
    return { messages, summary: existingSummary || '', compressedCount: 0 }
  }

  const toCompress = messages.slice(0, alignedIdx)
  const toKeep = messages.slice(alignedIdx)

  // 旧摘要已通过 existingSummary 单独传入，不再把上一次注入的摘要消息重复加入新对话。
  const firstMessage = toCompress[0]
  const hasInjectedSummary = Boolean(
    existingSummary
    && firstMessage?.role === 'user'
    && typeof firstMessage.content === 'string'
    && firstMessage.content.startsWith(SUMMARY_MESSAGE_PREFIX),
  )
  const newMessagesToCompress = hasInjectedSummary ? toCompress.slice(1) : toCompress

  // 把结构化模型消息转成带角色标记的文本，作为摘要模型的输入。
  const conversationText = newMessagesToCompress.map((msg) => {
    const content = typeof msg.content === 'string'
      ? msg.content
      : Array.isArray(msg.content)
        ? msg.content.map((p: any) => p.text || JSON.stringify(p.output || '')).join('')
        : ''

    return content ? `**${msg.role}**: ${content}` : ''
  }).filter(Boolean).join('\n\n')

  if (!conversationText.trim()) {
    return { messages, summary: existingSummary || '', compressedCount: 0 }
  }

  // 后续压缩通过“已有摘要 + 新增旧对话”生成新摘要，避免重新总结全部历史。
  const userPrompt = existingSummary
    ? `## 已有摘要（上一次压缩的结果）\n\n${existingSummary}\n\n## 需要压缩的新对话\n\n${conversationText}`
    : conversationText

  try {
    const { text: summary } = await generateText({
      model,
      system: COMPRESS_PROMPT,
      prompt: userPrompt,
    })

    // 摘要以普通模型消息注入上下文，与最近的完整对话共同传给主模型。
    const summaryMessage: ModelMessage = {
      role: 'user',
      content: `${SUMMARY_MESSAGE_PREFIX}\n\n${summary}\n\n[摘要结束，以下是最近的对话]`,
    }

    const newMessages: ModelMessage[] = [summaryMessage, ...toKeep]

    return {
      messages: newMessages,
      summary,
      compressedCount: toCompress.length,
    }
  }
  catch (err) {
    // 摘要不可用时保留原上下文，避免压缩失败影响主对话流程。
    console.error('[Compaction] LLM 摘要失败:', err)
    return { messages, summary: existingSummary || '', compressedCount: 0 }
  }
}

export { estimateTokens }
