/**
 * 根据错误消息中的疑似 HTTP 状态码、网络关键词和 AI SDK 无输出提示判断是否适合重试。
 *
 * @param error - 捕获到的异常值。
 * @returns 异常为可识别的临时错误时返回 `true`。
 */
export function isRetryable(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }

  const message = error.message || ''

  const statusMatch = message.match(/(\d{3})/)
  if (statusMatch) {
    const status = Number.parseInt(statusMatch[1], 10)
    if ([429, 529, 408].includes(status)) {
      return true
    }
    if (status >= 500 && status < 600) {
      return true
    }
    if (status >= 400 && status < 500) {
      return false
    }
  }

  if (message.includes('ECONNRESET') || message.includes('EPIPE')) {
    return true
  }
  if (message.includes('ETIMEDOUT') || message.includes('timeout')) {
    return true
  }
  if (message.includes('fetch failed') || message.includes('network')) {
    return true
  }
  // AI SDK 可能用此提示表示一次未生成输出的瞬时失败。
  if (message.includes('No output generated')) {
    return true
  }

  return false
}

/**
 * 计算指数退避延迟，并在截断后的指数值上下增加 25% 随机抖动。
 *
 * @param attempt - 从 1 开始的重试次数。
 * @param baseMs - 第一次重试的基础延迟毫秒数。
 * @param maxMs - 指数部分的截断值；加入抖动后的结果可能略高于此值。
 * @returns 四舍五入且不小于零的延迟毫秒数。
 */
export function calculateDelay(attempt: number, baseMs = 500, maxMs = 30000): number {
  const exponential = baseMs * 2 ** (attempt - 1)
  const capped = Math.min(exponential, maxMs)
  const jitterRange = capped * 0.25
  const jittered = capped + (Math.random() * 2 - 1) * jitterRange
  return Math.max(0, Math.round(jittered))
}

/**
 * 异步等待指定时长。
 *
 * @param ms - 等待的毫秒数。
 * @returns 等待结束后完成的 Promise。
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
