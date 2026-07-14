import type { ModelMessage } from 'ai'

/** 用于上下文防护判断的模型上下文窗口大小。 */
const CONTEXT_WINDOW = 200_000

/**
 * 结合 API 返回的精确 Token 数和新增消息字符数，跟踪当前上下文用量。
 * API 计数作为基准；尚未计入基准的内容按四个字符约等于一个 Token 估算。
 */
export class TokenTracker {
  private lastPreciseCount = 0 // 最近一次 API 返回的精确提示词 Token 数
  private pendingChars = 0 // 精确计数更新后新增、尚未由 API 统计的字符数

  /**
   * 使用 API 返回的精确计数重置当前估算基准。
   *
   * @param promptTokens - API 报告的提示词 Token 数。
   */
  updateFromAPI(promptTokens: number) {
    this.lastPreciseCount = promptTokens
    this.pendingChars = 0
  }

  /**
   * 记录一段尚未包含在 API 精确计数中的消息内容。
   *
   * @param content - 新增消息的文本内容。
   */
  addMessage(content: string) {
    this.pendingChars += content.length
  }

  /** @returns 精确基准与待统计字符估算值之和。 */
  get estimatedTokens(): number {
    return this.lastPreciseCount + Math.ceil(this.pendingChars / 4)
  }

  /**
   * 获取当前上下文用量及防护状态。
   *
   * @returns Token 估算值、占上下文窗口的整数百分比，以及用量达到 75% 时的处理标记。
   */
  get status(): { tokens: number, percent: number, needsAction: boolean } {
    const tokens = this.estimatedTokens
    const percent = Math.round((tokens / CONTEXT_WINDOW) * 100)
    return { tokens, percent, needsAction: percent >= 75 }
  }
}

/**
 * 根据消息中的文本和工具输出字符数估算 Token 用量。
 * 无法识别的内容块会被忽略，并使用 1.2 倍安全系数降低中文估算偏低的风险。
 *
 * @param messages - 要估算的模型消息列表。
 * @returns 向上取整后的 Token 估算值。
 * @throws 工具输出无法序列化为 JSON，或序列化结果不是字符串时抛出错误。
 */
export function estimatedMessageTokens(messages: ModelMessage[]): number {
  let chars = 0
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      chars += msg.content.length
    }
    else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if ('text' in part && typeof part.text === 'string') {
          chars += part.text.length
        }
        else if ('output' in part) {
          const out = typeof part.output === 'string' ? part.output : JSON.stringify(part.output)
          chars += out.length
        }
      }
    }
  }

  return Math.ceil((chars / 4) * 1.2)
}
