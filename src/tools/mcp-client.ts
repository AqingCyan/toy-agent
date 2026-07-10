import type { ChildProcess } from 'node:child_process'
import type { Interface } from 'node:readline'
import { spawn } from 'node:child_process'
import process from 'node:process'
import { createInterface } from 'node:readline'

interface MCPTool {
  /** `tools/call` 使用的工具名称。 */
  name: string
  /** 工具能力描述。 */
  description: string
  /** 工具入参的 JSON Schema。 */
  inputSchema: Record<string, unknown>
}

interface MCPCallResult {
  /** `tools/call` 返回的内容块。 */
  content: Array<{ type: string, text?: string }>
  /** 工具是否报告业务错误。 */
  isError?: boolean
}

/** 通过标准输入输出与 MCP 子进程通信的 JSON-RPC 客户端。 */
export class MCPClient {
  /** 当前 MCP 服务子进程。 */
  private process: ChildProcess | null = null
  /** 用于逐行消费服务端标准输出的读取接口。 */
  private rl: Interface | null = null
  /** 下一个 JSON-RPC 请求的序号来源。 */
  private requestId = 0
  /** 按请求 ID 保存尚未完成的调用。 */
  private pending = new Map<number, {
    resolve: (v: any) => void
    reject: (e: Error) => void
  }>()

  private serverName: string

  /**
   * 创建一个尚未连接的 MCP 客户端。
   *
   * @param command - 启动 MCP 服务的可执行命令。
   * @param args - 传给启动命令的参数。
   * @param env - 注入子进程的额外环境变量。
   */
  constructor(
    private command: string,
    private args: string[],
    private env?: Record<string, string>,
  ) {
    this.serverName = args[args.length - 1]?.replace(/^@.*\//, '') || 'mcp-server'
  }

  /**
   * 启动 MCP 子进程，建立逐行响应监听并完成协议握手。
   *
   * @returns 收到初始化响应并把 `initialized` 通知提交给输出流后兑现的 Promise。
   * @throws 当初始化请求超时或服务端返回 JSON-RPC 错误时抛出错误。
   */
  async connect(): Promise<void> {
    this.process = spawn(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.env },
    })

    this.process.on('error', (err) => {
      console.error(`  [MCP] 进程启动失败: ${err.message}`)
    })
    // 持续消费服务端日志，避免 stderr 管道因缓冲区写满而阻塞子进程。
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
      catch {
        // 服务端可能把非协议日志写入 stdout；这类行不参与请求匹配。
      }
    })

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

  /**
   * 发送一条 JSON-RPC 请求，并按响应 ID 或超时完成对应 Promise。
   *
   * @param method - JSON-RPC 方法名。
   * @param params - 可选的方法参数。
   * @returns 服务端响应中的 `result`。
   * @throws 当请求超过 15 秒未响应或服务端返回 JSON-RPC 错误时抛出错误。
   */
  private send(method: string, params?: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.requestId
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
      // MCP stdio 使用换行分隔 JSON-RPC 消息；缺少换行会让服务端继续等待当前帧。
      this.process!.stdin!.write(`${msg}\n`)
    })
  }

  /**
   * 获取服务端当前公开的工具定义。
   *
   * @returns MCP 工具定义列表；响应未提供 `tools` 时返回空数组。
   * @throws 当请求超时或服务端返回 JSON-RPC 错误时抛出错误。
   */
  async listTools(): Promise<MCPTool[]> {
    const result = await this.send('tools/list', {})
    return result.tools || []
  }

  /**
   * 调用指定 MCP 工具，并合并响应中的文本内容块。
   * `isError` 业务标记不会被单独转换为异常。
   *
   * @param name - 服务端原始工具名称。
   * @param args - 传给工具的参数对象。
   * @returns 以换行拼接的文本结果；没有文本内容时返回占位说明。
   * @throws 当请求超时或服务端返回 JSON-RPC 错误时抛出错误。
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const result: MCPCallResult = await this.send(
      'tools/call',
      { name, arguments: args },
    )
    const texts = (result.content || [])
      .filter(c => c.type === 'text' && c.text)
      .map(c => c.text!)
    return texts.join('\n') || '(无返回内容)'
  }

  /**
   * 停止读取响应并向 MCP 子进程发送终止信号。
   *
   * @returns 关闭读取接口并发送终止信号后兑现的 Promise；不会等待子进程退出或处理未完成请求。
   */
  async close(): Promise<void> {
    if (this.rl) {
      this.rl.close()
    }
    if (this.process) {
      this.process.kill()
    }
  }
}
