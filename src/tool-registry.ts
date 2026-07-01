import type { MCPClient } from './mcp-client'
import { jsonSchema } from 'ai'

// 单个工具的统一定义。这里既描述给模型看的能力，也保留运行时元数据。
export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute: (input: any) => Promise<unknown>

  // 元数据——给 Agent Loop 做决策用
  isConcurrencySafe?: boolean // 能否并行
  isReadOnly?: boolean // 是否只读
  maxResultChars?: number // 结果最大长度

  // 工具加载
  shouldDefer?: boolean // 是否延迟加载
  searchHint?: string // 搜索提示词，帮助 ToolSearch 匹配
}

const DEFAULT_MAX_RESULT_CHARS = 3000

export class ToolRegistry {
  // 以工具名为 key，方便注册覆盖和按名查找。
  private tools = new Map<string, ToolDefinition>()
  private mcpClients: Array<MCPClient> = []

  // 简单的读写锁状态：串行工具会持有独占锁；可并发工具会增加共享计数。
  private exclusiveLock = false
  private concurrentCount = 0

  // 当锁不可用时，把等待中的 Promise resolver 放进队列；释放锁后统一唤醒重试。
  private waitQueue: Array<() => void> = []

  // 记录已经被发现的延迟工具，避免在 getActiveTools 时重复返回未发现的工具。
  private discoveredTools = new Set<string>()

  register(...tools: ToolDefinition[]) {
    for (const tool of tools) {
      this.tools.set(tool.name, tool)
    }
  }

  // 注册 MCP server 的工具，给每个工具加上前缀，避免与本地工具冲突。
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

      this.register({
        name: prefixedName,
        description: `[MCP:${serverName} ${tool.description}]`,
        parameters: tool.inputSchema as Record<string, unknown>,
        isConcurrencySafe: true,
        isReadOnly: true,
        maxResultChars: 3000,
        shouldDefer: true,
        searchHint: `${serverName} ${tool.name} ${tool.description}`,
        execute: async (input: any) => toolClient.callTool(originalName, input),
      })

      registered.push(prefixedName)
    }

    return registered
  }

  // 关闭所有 MCP 客户端，释放子进程资源。注意：如果 Agent Loop 还在运行，调用这个方法可能会导致工具调用失败。
  async closeAllMCP(): Promise<void> {
    for (const client of this.mcpClients) {
      await client.close()
    }
    this.mcpClients = []
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)
  }

  getAll(): ToolDefinition[] {
    return Array.from(this.tools.values())
  }

  /**
   * 获取当前可用的工具列表，过滤掉未发现的延迟工具。
   * @returns 当前可用的工具定义数组
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
   * 获取延迟工具的提示信息，列出所有未发现的延迟工具及其搜索提示。
   * @returns 延迟工具提示信息字符串，如果没有延迟工具则返回空字符串
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
   * 根据工具名查询工具定义，支持逗号分隔多个工具名。返回匹配的工具定义数组，并将已发现的工具名记录在 discoveredTools 中。
   * @param query 工具名查询字符串，支持逗号分隔多个工具名
   * @returns 匹配的工具定义数组
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
   * 统计当前注册的工具的 token 估算值，包括已发现的工具和未发现的延迟工具。用于评估上下文窗口消耗。
   * @returns 一个对象，包含 active（已发现工具的 token 估算值）、deferred（未发现延迟工具的 token 估算值）和 total（总 token 估算值）三个属性
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

  private async acquireConcurrent(): Promise<void> {
    // 可并发工具只需要等待独占工具结束；多个可并发工具之间允许同时运行。
    while (this.exclusiveLock) {
      await new Promise<void>(r => this.waitQueue.push(r))
    }
    this.concurrentCount++
  }

  private releaseConcurrent(): void {
    this.concurrentCount--
    // 最后一个并发工具结束后，可能有串行工具正在等待独占执行权。
    if (this.concurrentCount === 0) {
      this.drainQueue()
    }
  }

  private async acquireExclusive(): Promise<void> {
    // 串行工具需要等独占锁空闲，并且所有并发工具都执行完，避免读写/写写冲突。
    while (this.exclusiveLock || this.concurrentCount > 0) {
      await new Promise<void>(r => this.waitQueue.push(r))
    }
    this.exclusiveLock = true
  }

  private releaseExclusive(): void {
    this.exclusiveLock = false
    // 独占工具结束后，唤醒等待队列，让后续工具重新竞争锁。
    this.drainQueue()
  }

  private drainQueue(): void {
    // splice(0) 会清空当前队列，避免 resolver 被重复调用。
    const waiting = this.waitQueue.splice(0)
    for (const resolve of waiting) resolve()
  }

  toAISDKFormat(): Record<string, any> {
    // 转成 AI SDK 期望的工具格式，并在统一出口处做结果裁剪
    const result: Record<string, any> = {}
    const activeTools = this.getActiveTools()

    for (const tool of activeTools) {
      const maxChars = tool.maxResultChars
      const executeFn = tool.execute
      // 只有显式声明可并发的工具才走共享锁；默认按串行处理更安全。
      const isSafe = tool.isConcurrencySafe === true

      result[tool.name] = {
        description: tool.description,
        inputSchema: jsonSchema(tool.parameters as any),
        execute: async (input: any) => {
          // 在统一包装层里做调度：读类/纯计算工具可并发，写类工具独占执行。
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
            // AI SDK 的工具结果最终按文本回传给模型，因此这里统一序列化。
            const text = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2)
            // 避免单个工具返回过大内容，快速消耗上下文窗口。
            return truncateResult(text, maxChars)
          }
          finally {
            // 不管工具成功、失败还是抛错，都必须释放锁，否则后续工具会一直等待。
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

export function truncateResult(text: string, maxChars: number = DEFAULT_MAX_RESULT_CHARS): string {
  if (text.length <= maxChars) {
    return text
  }

  // 优先保留开头和结尾：开头通常有上下文，结尾通常有结论或报错信息。
  const headSize = Math.floor(maxChars * 0.6)
  const tailSize = maxChars - headSize
  const head = text.slice(0, headSize)
  const tail = text.slice(-tailSize)
  const dropped = text.length - headSize - tailSize

  return `${head}\n\n... [省略 ${dropped} 字符] ...\n\n${tail}`
}
