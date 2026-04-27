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
}

const DEFAULT_MAX_RESULT_CHARS = 3000

export class ToolRegistry {
  // 以工具名为 key，方便注册覆盖和按名查找。
  private tools = new Map<string, ToolDefinition>()

  register(...tools: ToolDefinition[]) {
    for (const tool of tools) {
      this.tools.set(tool.name, tool)
    }
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)
  }

  getAll(): ToolDefinition[] {
    return Array.from(this.tools.values())
  }

  toAISDKFormat(): Record<string, any> {
    // 转成 AI SDK 期望的工具格式，并在统一出口处做结果裁剪，
    // 避免单个工具返回过大内容，快速消耗上下文窗口。
    const result: Record<string, any> = {}
    for (const [name, tool] of this.tools) {
      const maxChars = tool.maxResultChars
      const executeFn = tool.execute
      result[name] = {
        description: tool.description,
        inputSchema: jsonSchema(tool.parameters as any),
        execute: async (input: any) => {
          const raw = await executeFn(input)
          // AI SDK 的工具结果最终按文本回传给模型，因此这里统一序列化。
          const text = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2)
          return truncateResult(text, maxChars)
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
