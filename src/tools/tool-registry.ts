import type { MCPClient } from './mcp-client'
import { jsonSchema } from 'ai'

/** 模型可调用工具的描述、执行函数与运行时调度元数据。 */
export interface ToolDefinition {
  /** 注册和调用工具时使用的唯一名称。 */
  name: string
  /** 提供给模型的能力说明。 */
  description: string
  /** 提供给模型的输入 JSON Schema。 */
  parameters: Record<string, unknown>
  /**
   * 执行工具。
   *
   * @param input - 通过参数 Schema 校验后的调用参数。
   * @returns 兑现为工具执行结果的 Promise。
   */
  execute: (input: any) => Promise<unknown>

  /** 是否允许与其他并发安全工具同时执行。 */
  isConcurrencySafe?: boolean
  /** 工具是否只读取外部状态。 */
  isReadOnly?: boolean
  /** 裁剪时最多保留的原文字符数；省略标记不计入。 */
  maxResultChars?: number
  /** 是否在被发现前隐藏工具定义。 */
  shouldDefer?: boolean
  /** 帮助模型发现延迟工具的提示文本。 */
  searchHint?: string
}

const DEFAULT_MAX_RESULT_CHARS = 3000

/** 负责工具注册、延迟发现、执行调度和 AI SDK 格式转换。 */
export class ToolRegistry {
  /** 以名称索引的工具定义；同名注册会覆盖已有定义。 */
  private tools = new Map<string, ToolDefinition>()
  /** 已连接且需要在退出时关闭的 MCP 客户端。 */
  private mcpClients: Array<MCPClient> = []

  /** 是否有非并发安全工具持有独占执行权。 */
  private exclusiveLock = false
  /** 当前正在执行的并发安全工具数量。 */
  private concurrentCount = 0

  /** 等待锁状态变化的任务唤醒函数。 */
  private waitQueue: Array<() => void> = []

  /** 已通过搜索显式发现的延迟工具名称。 */
  private discoveredTools = new Set<string>()

  /**
   * 注册一个或多个工具，同名工具以后注册的定义为准。
   *
   * @param tools - 要加入注册表的工具定义。
   */
  register(...tools: ToolDefinition[]) {
    for (const tool of tools) {
      this.tools.set(tool.name, tool)
    }
  }

  /**
   * 连接 MCP 服务，并把其工具以前缀名称注册为延迟工具。
   *
   * @param serverName - 用于构造 `mcp__<server>__<tool>` 名称的服务标识。
   * @param client - 尚待连接的 MCP 客户端。
   * @returns 成功注册的前缀工具名称列表；同名工具会被跳过。
   * @throws 当 MCP 连接或工具列表请求失败时抛出错误。
   */
  async registerMCPServer(serverName: string, client: MCPClient): Promise<string[]> {
    await client.connect()
    this.mcpClients.push(client)

    const tools = await client.listTools()
    const registered: string[] = []

    for (const tool of tools) {
      const prefixedName = `mcp__${serverName}__${tool.name}`
      if (this.tools.has(prefixedName)) {
        console.warn(`  [MCP] 工具 ${prefixedName} 已存在，跳过注册`)
        continue
      }

      const toolClient = client
      const originalName = tool.name

      // 当前类型未读取服务端 annotations，因此暂按只读、可并发注册；接入写工具时需调整该假设。
      this.register({
        name: prefixedName,
        description: `[MCP:${serverName} ${tool.description}]`,
        parameters: tool.inputSchema as Record<string, unknown>,
        isConcurrencySafe: true,
        isReadOnly: true,
        maxResultChars: 3000,
        shouldDefer: true,
        searchHint: `${serverName} ${tool.name} ${tool.description}`,
        /**
         * 将注册表调用转发给 MCP 服务端的原始工具。
         *
         * @param input - MCP 工具调用参数。
         * @returns MCP 客户端合并后的文本结果。
         * @throws MCP 请求超时或服务端返回 JSON-RPC 错误时抛出错误。
         */
        execute: async (input: any) => toolClient.callTool(originalName, input),
      })

      registered.push(prefixedName)
    }

    return registered
  }

  /**
   * 依次请求关闭已连接的 MCP 客户端，并清空客户端列表。
   * Agent Loop 仍在执行时调用，进行中的请求可能失败或超时；已注册工具不会被注销。
   *
   * @returns 所有客户端都收到关闭信号后兑现的 Promise；不保证子进程已经退出。
   * @throws 当任一客户端关闭失败时抛出错误。
   */
  async closeAllMCP(): Promise<void> {
    for (const client of this.mcpClients) {
      await client.close()
    }
    this.mcpClients = []
  }

  /**
   * 按完整名称查找工具。
   *
   * @param name - 工具名称。
   * @returns 对应的工具定义，不存在时返回 `undefined`。
   */
  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)
  }

  /**
   * 获取注册表中的全部工具，包括尚未发现的延迟工具。
   *
   * @returns 按注册顺序排列的工具定义数组。
   */
  getAll(): ToolDefinition[] {
    return Array.from(this.tools.values())
  }

  /**
   * 获取当前可用的工具，排除尚未发现的延迟工具。
   *
   * @returns 当前可提供给模型的工具定义数组。
   */
  getActiveTools(): ToolDefinition[] {
    return this.getAll().filter((tool) => {
      if (tool.shouldDefer && !this.discoveredTools.has(tool.name)) {
        return false
      }
      return true
    })
  }

  /**
   * 生成尚未发现的延迟工具摘要，供系统提示引导工具发现。
   *
   * @returns 延迟工具名称与搜索提示；没有待发现工具时返回空字符串。
   */
  getDeferredToolSummary(): string {
    const deferred = this.getAll().filter((tool) => {
      return tool.shouldDefer && !this.discoveredTools.has(tool.name)
    })

    if (deferred.length === 0) {
      return ''
    }

    const lines = deferred.map((tool) => {
      const hint = tool.searchHint ? ` - ${tool.searchHint}` : ''
      return ` - ${tool.name}${hint}`
    })

    return `\n以下工具可用，但需要先通过 tool_search 搜索获取完整定义：\n${lines.join('\n')}`
  }

  /**
   * 按精确名称查找工具，并将命中的延迟工具标记为已发现。
   *
   * @param query - 单个工具名或以逗号分隔的多个工具名。
   * @returns 按查询顺序排列的工具定义；`tool_search` 本身不会被返回。
   */
  searchTools(query: string): ToolDefinition[] {
    const q = query.trim()
    const result: ToolDefinition[] = []

    const names = q.includes(',') ? q.split(',').map(n => n.trim()).filter(Boolean) : [q]

    for (const name of names) {
      const tool = this.tools.get(name)
      if (tool && tool.name !== 'tool_search') {
        result.push(tool)
        this.discoveredTools.add(tool.name)
      }
    }

    return result
  }

  /**
   * 按序列化字符数估算活跃工具和延迟工具占用的 token 数。
   *
   * @returns 活跃、延迟以及两者合计的 token 估算值。
   */
  countTokenEstimate(): { active: number, deferred: number, total: number } {
    let active = 0
    let deferred = 0

    for (const tool of this.tools.values()) {
      const schemaSize = JSON.stringify({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }).length
      const tokens = Math.ceil(schemaSize / 4)

      if (tool.shouldDefer && !this.discoveredTools.has(tool.name)) {
        deferred += tokens
      }
      else {
        active += tokens
      }
    }

    return { active, deferred, total: active + deferred }
  }

  /**
   * 等待独占工具结束，然后登记一个并发安全工具正在执行。
   * 该锁偏向并发安全任务且不保证 FIFO，持续的新共享任务可能延后独占任务。
   *
   * @returns 获得共享执行权后兑现的 Promise。
   */
  private async acquireConcurrent(): Promise<void> {
    while (this.exclusiveLock) {
      await new Promise<void>(r => this.waitQueue.push(r))
    }
    this.concurrentCount++
  }

  /**
   * 释放一个并发安全工具占用的共享执行权。
   */
  private releaseConcurrent(): void {
    this.concurrentCount--
    if (this.concurrentCount === 0) {
      this.drainQueue()
    }
  }

  /**
   * 等待其他工具全部结束，然后获取独占执行权。
   *
   * @returns 获得独占执行权后兑现的 Promise。
   */
  private async acquireExclusive(): Promise<void> {
    while (this.exclusiveLock || this.concurrentCount > 0) {
      await new Promise<void>(r => this.waitQueue.push(r))
    }
    this.exclusiveLock = true
  }

  /**
   * 释放独占执行权并唤醒等待中的任务。
   */
  private releaseExclusive(): void {
    this.exclusiveLock = false
    this.drainQueue()
  }

  /**
   * 唤醒当前等待队列中的全部任务，使其重新检查锁状态。
   */
  private drainQueue(): void {
    const waiting = this.waitQueue.splice(0)
    for (const resolve of waiting) resolve()
  }

  /**
   * 将当前活跃工具转换为 AI SDK 格式，并包装并发调度与结果截断逻辑。
   *
   * @returns 以工具名为键的 AI SDK 工具对象。
   */
  toAISDKFormat(): Record<string, any> {
    const result: Record<string, any> = {}
    const activeTools = this.getActiveTools()

    for (const tool of activeTools) {
      const maxChars = tool.maxResultChars
      const executeFn = tool.execute
      // 未显式声明并发安全的工具默认使用独占执行权。
      const isSafe = tool.isConcurrencySafe === true

      result[tool.name] = {
        description: tool.description,
        inputSchema: jsonSchema(tool.parameters as any),
        /**
         * 在注册表调度约束内执行工具，并把结果序列化、截断为文本。
         *
         * @param input - 通过 AI SDK Schema 校验的工具参数。
         * @returns 适合回传给模型的文本结果。
         * @throws 工具执行失败或结果无法序列化为文本时抛出错误。
         */
        execute: async (input: any) => {
          if (isSafe) {
            await this.acquireConcurrent()
            console.log(`  [并发] ${tool.name} 获取共享锁`)
          }
          else {
            await this.acquireExclusive()
            console.log(`  [串行] ${tool.name} 获取独占锁，等待其他工具完成`)
          }
          try {
            const raw = await executeFn(input)
            const text = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2)
            return truncateResult(text, maxChars)
          }
          finally {
            // 异常路径也必须释放执行权，否则后续工具会永久等待。
            if (isSafe) {
              this.releaseConcurrent()
            }
            else {
              this.releaseExclusive()
            }
          }
        },
      }
    }
    return result
  }
}

/**
 * 将过长结果裁剪为头尾两段，并在中间标明省略字符数。
 * 头部通常提供上下文，尾部通常包含结论或错误，因此按约 60%/40% 保留两端。
 *
 * @param text - 待检查的完整文本。
 * @param maxChars - 最多保留的原文字符数，默认为 3000；不包含省略标记。
 * @returns 未超限的原文本，或保留约 60% 开头和 40% 结尾的裁剪结果。
 */
export function truncateResult(text: string, maxChars: number = DEFAULT_MAX_RESULT_CHARS): string {
  if (text.length <= maxChars) {
    return text
  }

  const headSize = Math.floor(maxChars * 0.6)
  const tailSize = maxChars - headSize
  const head = text.slice(0, headSize)
  const tail = text.slice(-tailSize)
  const dropped = text.length - headSize - tailSize

  return `${head}\n\n... [省略 ${dropped} 字符] ...\n\n${tail}`
}
