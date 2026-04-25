import type { ModelMessage } from 'ai'
import process from 'node:process'
import { createInterface } from 'node:readline'
import { createOpenAI } from '@ai-sdk/openai'
import { stepCountIs, streamText } from 'ai'
import { calculatorTool, weatherTool } from './tool'
import 'dotenv/config'

// 模型定义
const mimo = createOpenAI({
  baseURL: 'https://token-plan-cn.xiaomimimo.com/v1',
  apiKey: process.env.DASHSCOPE_API_KEY,
})

const model = mimo.chat('mimo-v2.5-pro')

// 工具定义
const tools = { get_weather: weatherTool, calculate: calculatorTool }

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
})

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

    const result = streamText({
      model,
      system: `你是 Toy Agent，一个专注于软件开发的 AI 助手。你说话简洁直接，喜欢用代码示例来解释问题。如果用户的问题不够清晰，你会反问而不是瞎猜。`,
      messages,
      tools,
      stopWhen: stepCountIs(5), // 最多调用 5 次工具
    })

    process.stdout.write('Assistant: ')
    let fullResponse = ''

    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'text-delta':
          process.stdout.write(part.text)
          fullResponse += part.text
          break
        case 'tool-call':
          console.log(`\n[调用工具: ${part.toolName}，输入: ${JSON.stringify(part.input)}]`)
          break
        case 'tool-result':
          console.log(`\n[工具结果: ${JSON.stringify(part.output)}]`)
          break
      }
    }

    console.log() // 换行
    messages.push({ role: 'assistant', content: fullResponse })

    ask()
  })
}

console.log('Toy Agent v0.1 (type "exit" to quit)\n')

ask()
