import type { ModelMessage } from 'ai'
import process from 'node:process'
import { createInterface } from 'node:readline'
import { createOpenAI } from '@ai-sdk/openai'
import { agentLoop } from './agent-loop'
import { calculatorTool, weatherTool } from './tool'
import 'dotenv/config'

const SYSTEM_PROMPT = `你是 Toy Agent，一个专注于软件开发的 AI 助手。你说话简洁直接，喜欢用代码示例来解释问题。如果用户的问题不够清晰，你会反问而不是瞎猜。`

// 模型定义
const mimo = createOpenAI({
  baseURL: 'https://token-plan-cn.xiaomimimo.com/v1',
  apiKey: process.env.DASHSCOPE_API_KEY,
})
const model = mimo.chat('mimo-v2.5-pro')

// 工具定义
const tools = { get_weather: weatherTool, calculate: calculatorTool }

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

    await agentLoop(model, tools, messages, SYSTEM_PROMPT)

    ask()
  })
}

console.log('Toy Agent v0.2 - Agent Loop (type "exit" to quit)\n')

ask()
