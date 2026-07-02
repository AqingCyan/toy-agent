import type { ChildProcess } from 'node:child_process'
import type { Interface } from 'node:readline'
import { spawn } from 'node:child_process'
import process from 'node:process'
import { createInterface } from 'node:readline'

interface MCPTool {
  /** 工具名称，用于 tools/call 时指定要调用的工具。 */
  name: string
  /** 工具描述，用于展示工具能力和使用场景。 */
  description: string
  /** MCP 工具的入参 JSON Schema，用于描述调用这个工具需要传什么参数。 */
  inputSchema: Record<string, unknown>
}

interface MCPCallResult {
  /** MCP tools/call 的返回内容可能包含多种类型，这里只关心 text 内容。 */
  content: Array<{ type: string, text?: string }>
  /** 标记工具调用是否返回业务错误。 */
  isError?: boolean
}

export class MCPClient {
  /** MCP server 以子进程方式运行，客户端通过 stdin/stdout 与它通信。 */
  private process: ChildProcess | null = null
  /** readline 用来按行读取 stdout，因为 MCP stdio 消息是一行一个 JSON。 */
  private rl: Interface | null = null
  /** JSON-RPC 请求自增 id，用于匹配请求和响应。 */
  private requestId = 0
  /** 保存未完成的 JSON-RPC 请求，收到相同 id 的响应后再 resolve/reject。 */
  private pending = new Map<number, {
    resolve: (v: any) => void
    reject: (e: Error) => void
  }>()

  /** MCP server 名称，当前主要由构造参数推断得到。 */
  private serverName: string

  constructor(
    /** 启动 MCP server 的命令。 */
    private command: string,
    /** 启动 MCP server 时传给命令的参数。 */
    private args: string[],
    /** 额外注入给 MCP server 子进程的环境变量。 */
    private env?: Record<string, string>,
  ) {
    // 从包名参数里推断一个服务名；当前类里暂未使用，后续可用于日志展示。
    this.serverName = args[args.length - 1]?.replace(/^@.*\//, '') || 'mcp-server'
  }

  async connect(): Promise<void> {
    // 使用 pipe 是 MCP stdio 的关键：stdin 发请求，stdout 收响应，stderr 收日志。
    this.process = spawn(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.env },
    })

    this.process.on('error', (err) => {
      console.error(`  [MCP] 进程启动失败: ${err.message}`)
    })
    this.process.stderr?.on('data', () => {})

    this.rl = createInterface({ input: this.process.stdout! })
    this.rl.on('line', (line) => {
      try {
        const msg = JSON.parse(line)
        // JSON-RPC 响应会带 id，用它找到对应的 pending 请求。
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!
          this.pending.delete(msg.id)
          if (msg.error) {
            p.reject(new Error(
              `MCP error ${msg.error.code}: ${msg.error.message}`,
            ))
          }
          else {
            p.resolve(msg.result)
          }
        }
      }
      catch { /* ignore non-JSON lines */ }
    })

    // MCP 握手：先 initialize，服务端确认后再发送 initialized 通知。
    await this.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'toy-agent', version: '0.5.0' },
    })

    this.process.stdin!.write(`${JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    })}\n`)
  }

  private send(method: string, params?: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.requestId
      // 防止 MCP server 无响应时 Promise 永远挂起。
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP request timeout: ${method}`))
      }, 15000)

      this.pending.set(id, {
        resolve: (v: any) => {
          clearTimeout(timeout)
          resolve(v)
        },
        reject: (e: Error) => {
          clearTimeout(timeout)
          reject(e)
        },
      })

      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params })
      // stdio 协议要求每条 JSON-RPC 消息独占一行。
      this.process!.stdin!.write(`${msg}\n`)
    })
  }

  async listTools(): Promise<MCPTool[]> {
    const result = await this.send('tools/list', {})
    return result.tools || []
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    // MCP 约定工具参数字段名为 arguments。
    const result: MCPCallResult = await this.send(
      'tools/call',
      { name, arguments: args },
    )
    // 当前调用方只需要文本输出，因此过滤并拼接 text 类型内容。
    const texts = (result.content || [])
      .filter(c => c.type === 'text' && c.text)
      .map(c => c.text!)
    return texts.join('\n') || '(无返回内容)'
  }

  async close(): Promise<void> {
    if (this.rl) {
      this.rl.close()
    }
    if (this.process) {
      this.process.kill()
    }
  }
}
