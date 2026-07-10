import { createHash } from 'node:crypto'

/** 循环检测窗口中的一次工具调用。 */
export interface ToolCallRecord {
  /** 工具名称。 */
  toolName: string
  /** 包含工具名称和参数的稳定指纹。 */
  argsHash: string
  /** 工具返回后补写的结果指纹。 */
  resultHash?: string
  /** 调用被记录时的 Unix 毫秒时间戳。 */
  timestamp: number
}

/** 能触发循环警告或熔断的检测器类型。 */
export type DetectorKind = 'generic_repeat' | 'ping_pong' | 'global_circuit_breaker'

/** 循环检测结果；命中时包含严重级别、来源、次数与用户提示。 */
export type DetectionResult = { stuck: false } | { stuck: true, level: 'warning' | 'critical', detector: DetectorKind, count: number, message: string }

const HISTORY_SIZE = 30
// 以下低阈值用于演示；生产环境应按工具调用模式和成本重新校准。
const WARNING_THRESHOLD = 5
const CRITICAL_THRESHOLD = 8
const BREAKER_THRESHOLD = 10

/**
 * 将 JSON 可序列化值转换为对象键顺序稳定的字符串，同时保留数组元素顺序。
 *
 * @param value - 要序列化的 JSON 兼容值。
 * @returns 键顺序稳定的序列化结果。
 * @throws 值包含 BigInt、循环引用等 JSON 无法序列化的结构时抛出错误。
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }

  const keys = Object.keys(value as Record<string, unknown>).sort()
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify((value as any)[k])}`).join(',')}}`
}

/**
 * 生成用于内部比较的短 SHA-256 哈希。
 *
 * @param input - 要计算哈希的字符串。
 * @returns SHA-256 摘要的前 16 个十六进制字符。
 */
function hash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16)
}

/**
 * 根据工具名称和参数生成稳定的调用指纹。
 *
 * @param toolName - 工具名称。
 * @param params - JSON 可序列化的工具调用参数。
 * @returns 包含工具名称的调用指纹。
 * @throws 参数无法稳定序列化时抛出错误。
 */
export function hashToolCall(toolName: string, params: unknown): string {
  return `${toolName}:${hash(stableStringify(params))}`
}

/**
 * 根据工具结果生成稳定指纹。
 *
 * @param result - JSON 可序列化的工具执行结果。
 * @returns 工具结果的短哈希。
 * @throws 结果无法稳定序列化时抛出错误。
 */
export function hashResult(result: unknown): string {
  return hash(stableStringify(result))
}

const history: ToolCallRecord[] = []

/**
 * 记录一次待执行的工具调用，并将历史限制在最近的固定窗口内。
 *
 * @param toolName - 工具名称。
 * @param params - JSON 可序列化的工具调用参数。
 * @throws 参数无法稳定序列化时抛出错误。
 */
export function recordCall(toolName: string, params: unknown) {
  history.push({ toolName, argsHash: hashToolCall(toolName, params), timestamp: Date.now() })
  if (history.length > HISTORY_SIZE) {
    history.shift()
  }
}

/**
 * 将结果指纹关联到最近一条工具和参数均匹配且尚无结果的调用记录。
 *
 * @param toolName - 工具名称。
 * @param params - JSON 可序列化的工具调用参数。
 * @param result - JSON 可序列化的工具执行结果。
 * @throws 参数或结果无法稳定序列化时抛出错误。
 */
export function recordResult(toolName: string, params: unknown, result: unknown) {
  const argsHash = hashToolCall(toolName, params)
  const resultHash = hashResult(result)

  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].toolName === toolName && history[i].argsHash === argsHash && !history[i].resultHash) {
      history[i].resultHash = resultHash
      break
    }
  }
}

/**
 * 清空模块级共享的工具调用历史。
 */
export function resetHistory() {
  history.length = 0
}

/**
 * 统计指定调用指纹最近连续返回相同结果的次数。
 * 其他调用及尚无结果的记录会被跳过，遇到该指纹的不同结果时停止统计。
 *
 * @param toolName - 工具名称。
 * @param argHash - 包含工具名称和参数的调用指纹。
 * @returns 从最新结果向前连续相同的次数。
 */
function getNoProgressStreak(toolName: string, argHash: string): number {
  let streak = 0
  let lastResultHash: string | undefined

  for (let i = history.length - 1; i >= 0; i--) {
    const r = history[i]
    if (r.toolName !== toolName || r.argsHash !== argHash) {
      continue
    }
    if (!r.resultHash) {
      continue
    }
    if (!lastResultHash) {
      lastResultHash = r.resultHash
      streak = 1
      continue
    }
    if (r.resultHash !== lastResultHash) {
      break
    }
    streak++
  }
  return streak
}

/**
 * 计算当前调用加入后，历史尾部在两个调用指纹之间严格交替的长度。
 * 该检测只比较调用指纹，不比较工具结果；当前调用未延续交替模式时返回零。
 *
 * @param currentHash - 当前准备执行的工具调用指纹。
 * @returns 加入当前调用后的交替长度，未形成乒乓模式时返回零。
 */
function getPingPongCount(currentHash: string): number {
  if (history.length < 3) {
    return 0
  }

  const last = history[history.length - 1]
  let otherHash: string | undefined

  for (let i = history.length - 2; i >= 0; i--) {
    if (history[i].argsHash !== last.argsHash) {
      otherHash = history[i].argsHash
      break
    }
  }

  if (!otherHash) {
    return 0
  }

  let count = 0
  for (let i = history.length - 1; i >= 0; i--) {
    const expected = count % 2 === 0 ? last.argsHash : otherHash
    if (history[i].argsHash !== expected) {
      break
    }
    count++
  }

  if (currentHash === otherHash && count >= 2) {
    return count + 1
  }

  return 0
}

/**
 * 在当前调用入库前，根据近期历史检测无进展、乒乓和同参数重复循环。
 *
 * @param toolName - 当前准备调用的工具名称。
 * @param params - JSON 可序列化的当前工具调用参数。
 * @returns 未命中循环时返回正常结果，否则返回检测级别、类型、次数和提示信息。
 * @throws 参数无法稳定序列化时抛出错误。
 */
export function detect(toolName: string, params: unknown): DetectionResult {
  const argsHash = hashToolCall(toolName, params)
  const noProgress = getNoProgressStreak(toolName, argsHash)

  if (noProgress >= BREAKER_THRESHOLD) {
    return { stuck: true, level: 'critical', detector: 'global_circuit_breaker', count: noProgress, message: `[熔断] ${toolName} 已重复 ${noProgress} 次且无进展，强制停止` }
  }

  const pingPong = getPingPongCount(argsHash)
  if (pingPong >= CRITICAL_THRESHOLD) {
    return { stuck: true, level: 'critical', detector: 'ping_pong', count: pingPong, message: `  [熔断] 检测到乒乓循环（${pingPong} 次交替），强制停止` }
  }
  if (pingPong >= WARNING_THRESHOLD) {
    return { stuck: true, level: 'warning', detector: 'ping_pong', count: pingPong, message: `  [警告] 检测到乒乓循环（${pingPong} 次交替），建议换个思路` }
  }

  const recentCount = history.filter(h => h.toolName === toolName && h.argsHash === argsHash).length
  if (recentCount >= CRITICAL_THRESHOLD) {
    return { stuck: true, level: 'critical', detector: 'generic_repeat', count: recentCount, message: `  [熔断] ${toolName} 相同参数已调用 ${recentCount} 次，强制停止` }
  }
  if (recentCount >= WARNING_THRESHOLD) {
    return { stuck: true, level: 'warning', detector: 'generic_repeat', count: recentCount, message: `  [警告] ${toolName} 相同参数已调用 ${recentCount} 次，你可能陷入了重复` }
  }

  return { stuck: false }
}
