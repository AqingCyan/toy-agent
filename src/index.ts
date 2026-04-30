import type { ModelMessage } from 'ai'
import process from 'node:process'
import { createInterface } from 'node:readline'
import { createOpenAI } from '@ai-sdk/openai'
import { agentLoop } from './agent-loop'
import { ToolRegistry } from './tool-registry'
import { allTools } from './tools'
import 'dotenv/config'

const SYSTEM_PROMPT = `你是 Toy Agent，一个专注于软件开发的 AI 助手。你说话简洁直接，喜欢用代码示例来解释问题。如果用户的问题不够清晰，你会反问而不是瞎猜。`

// 模型定义
const mimo = createOpenAI({
  baseURL: 'https://token-plan-cn.xiaomimimo.com/v1',
  apiKey: process.env.DASHSCOPE_API_KEY,
})
const model = mimo.chat('mimo-v2.5-pro')

// 工具定义：集中注册后，Agent Loop 只依赖注册表，不需要直接关心每个工具的实现细节。
const registry = new ToolRegistry()
registry.register(...allTools)

// 启动时打印工具清单和元数据，方便确认工具是否可并发、是否只读。
console.log(`已注册 ${registry.getAll().length} 个工具：`)

for (const tool of registry.getAll()) {
  // flags 是给人看的运行策略说明，不参与模型推理。
  const flags = [
    tool.isConcurrencySafe ? '可并发' : '串行',
    tool.isReadOnly ? '只读' : '读写',
  ].join(', ')
  console.log(`  - ${tool.name}（${flags}）`)
}

// 简单的交互式命令行定义
const rl = createInterface({ input: process.stdin, output: process.stdout })

// 消息历史
const messages: ModelMessage[] = []

function ask() {
  rl.question('\nYou: ', async (input) => {
    const trimmed = input.trim()
    if (!trimmed || trimmed === 'exit') {
      console.log('Good Bye! 👋')
      rl.close()
      return
    }

    messages.push({ role: 'user', content: trimmed })

    await agentLoop(model, registry, messages, SYSTEM_PROMPT)

    ask()
  })
}

console.log('Toy Agent v0.2 - Agent Loop (type "exit" to quit)\n')

ask()
