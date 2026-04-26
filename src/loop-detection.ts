import { createHash } from 'node:crypto'

export interface ToolCallRecord {
  toolName: string
  argsHash: string
  resultHash?: string
  timestamp: number
}

export type DetectorKind = 'generic_repeat' | 'ping_pong' | 'global_circuit_breaker'

export type DetectionResult = { stuck: false } | { stuck: true, level: 'warning' | 'critical', detector: DetectorKind, count: number, message: string }

const HISTORY_SIZE = 30 // 滑动窗口大小
const WARNING_THRESHOLD = 5 // 警告阈值（演示用，生产环境通常是 10）
const CRITICAL_THRESHOLD = 8 // 严重阈值（演示用，生产环境通常是 20）
const BREAKER_THRESHOLD = 10 // 熔断阈值（演示用，生产环境通常是 30）

// --- 指纹计算 ---
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

function hash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16)
}

export function hashToolCall(toolName: string, params: unknown): string {
  return `${toolName}:${hash(stableStringify(params))}`
}

export function hashResult(result: unknown): string {
  return hash(stableStringify(result))
}

// --- 滑动窗口 ---
const history: ToolCallRecord[] = []

export function recordCall(toolName: string, params: unknown) {
  history.push({ toolName, argsHash: hashToolCall(toolName, params), timestamp: Date.now() })
  if (history.length > HISTORY_SIZE) {
    history.shift()
  }
}

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

export function resetHistory() {
  history.length = 0
}

// --- 检测器 ---
/**
 * 统计“同一个工具 + 同一组参数”最近连续多少次返回了完全相同的结果。
 *
 * 这个检测器用于识别“看起来一直在调用工具，但实际上没有任何新进展”的情况。
 * 它会从最新记录开始向前扫描，只关注满足以下条件的历史项：
 * 1. `toolName` 相同
 * 2. `argsHash` 相同
 * 3. 已经有 `resultHash`（说明这次调用已经返回结果）
 *
 * 判断规则：
 * - 先把最近一次匹配到的 `resultHash` 作为基准结果
 * - 继续向前看，只要更早的结果哈希和这个基准一致，就认为仍然处于“无进展连续段”中
 * - 一旦遇到不同的 `resultHash`，就停止统计
 * - 中间遇到别的工具、别的参数，或者尚未写入结果的记录，会直接跳过，不会打断连续段
 *
 * 例子 1：连续无进展
 * history（从旧到新）:
 * - search(A) -> X
 * - search(A) -> X
 * - search(A) -> X
 * 返回：3
 *
 * 例子 2：最近两次相同，但再往前结果变了
 * history（从旧到新）:
 * - search(A) -> X
 * - search(A) -> Y
 * - search(A) -> Y
 * 返回：2
 * 说明：函数只统计“从最近开始连续相同”的长度，不会把更早的 X 算进去。
 *
 * 例子 3：夹杂其他调用，不影响统计
 * history（从旧到新）:
 * - search(A) -> X
 * - read(B)   -> R
 * - search(A) -> X
 * 返回：2
 * 说明：`read(B)` 会被跳过，因为它不是同一个工具/参数组合。
 *
 * 例子 4：最近一次还没有结果
 * history（从旧到新）:
 * - search(A) -> X
 * - search(A) -> [pending]
 * - search(A) -> X
 * 返回：2
 * 说明：没有 `resultHash` 的记录不会参与比较，也不会打断统计。
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
 * 检测最近的参数哈希是否在两个值之间来回交替（ping-pong / 乒乓循环）。
 *
 * 这个检测器用于识别另一类常见死循环：不是单点重复，而是在两个调用状态之间反复横跳。
 * 典型模式如下（从旧到新）：
 * - A
 * - B
 * - A
 * - B
 * - A
 *
 * 函数的工作方式：
 * 1. 取历史中的最后一个 `argsHash` 作为最近状态 `last.argsHash`
 * 2. 从后往前找到第一个与它不同的哈希，记为 `otherHash`
 * 3. 再从最新记录开始反向检查，看看历史尾部是否严格满足：
 *    `last.argsHash`, `otherHash`, `last.argsHash`, `otherHash` ...
 * 4. 如果当前准备执行的 `currentHash` 恰好等于 `otherHash`，说明“下一步”会继续这个交替模式，
 *    这时返回交替长度 `count + 1`
 * 5. 否则返回 `0`，表示当前调用不会延续这个乒乓循环
 *
 * 注意：
 * - 这里检测的是“参数哈希”的交替，不直接比较结果哈希
 * - 它关注的是历史尾部是否形成了严格的 A/B/A/B 模式
 * - 只有当“当前即将发生的调用”正好补上另一个值时，才认为循环会继续
 *
 * 例子 1：形成乒乓循环
 * history（从旧到新）:
 * - A
 * - B
 * - A
 * - B
 * currentHash = A
 *
 * 从后往前看，历史尾部是：B, A, B, A
 * `last.argsHash = B`，`otherHash = A`，已经形成长度为 4 的交替段。
 * 当前又要执行 A，正好继续这个模式，所以返回 5。
 *
 * 例子 2：历史有交替，但当前不会继续
 * history（从旧到新）:
 * - A
 * - B
 * - A
 * - B
 * currentHash = C
 *
 * 虽然历史尾部是交替的，但当前不是 A，而是 C，
 * 所以下一步不会继续 A/B/A/B 模式，返回 0。
 *
 * 例子 3：不是严格交替
 * history（从旧到新）:
 * - A
 * - B
 * - B
 * - A
 * currentHash = B
 *
 * 从最新往前看是：A, B, B ...
 * 到第三项时不再满足 A/B/A/B 的严格交替，因此不会被识别为 ping-pong，返回 0。
 *
 * 例子 4：历史太短
 * history（从旧到新）:
 * - A
 * - B
 * currentHash = A
 *
 * 长度不足以稳定判断交替模式，直接返回 0。
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

// --- 主检测函数 ---
export function detect(toolName: string, params: unknown): DetectionResult {
  const argsHash = hashToolCall(toolName, params)
  const noProgress = getNoProgressStreak(toolName, argsHash)

  if (noProgress >= BREAKER_THRESHOLD) {
    return { stuck: true, level: 'critical', detector: 'global_circuit_breaker', count: noProgress, message: `[熔断] ${toolName} 已重复 ${noProgress} 次且无进展，强制停止` }
  }

  const pingPong = getPingPongCount(argsHash)
  if (pingPong >= CRITICAL_THRESHOLD) {
    return { stuck: true, level: 'critical', detector: 'ping_pong', count: pingPong, message: `[熔断] 检测到乒乓循环（${pingPong} 次交替），强制停止` }
  }
  if (pingPong >= WARNING_THRESHOLD) {
    return { stuck: true, level: 'warning', detector: 'ping_pong', count: pingPong, message: `[警告] 检测到乒乓循环（${pingPong} 次交替），建议换个思路` }
  }

  const recentCount = history.filter(h => h.toolName === toolName && h.argsHash === argsHash).length
  if (recentCount >= CRITICAL_THRESHOLD) {
    return { stuck: true, level: 'critical', detector: 'generic_repeat', count: recentCount, message: `[熔断] ${toolName} 相同参数已调用 ${recentCount} 次，强制停止` }
  }
  if (recentCount >= WARNING_THRESHOLD) {
    return { stuck: true, level: 'warning', detector: 'generic_repeat', count: recentCount, message: `[警告] ${toolName} 相同参数已调用 ${recentCount} 次，你可能陷入了重复` }
  }

  return { stuck: false }
}
