import type { ModelMessage } from 'ai'
import process from 'node:process'
import { createInterface } from 'node:readline'
import { createOpenAI } from '@ai-sdk/openai'
import { streamText } from 'ai'
import 'dotenv/config'

const mimo = createOpenAI({
  baseURL: 'https://token-plan-cn.xiaomimimo.com/v1',
  apiKey: process.env.DASHSCOPE_API_KEY,
})

const model = mimo.chat('mimo-v2.5-pro')

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
      system: `你是 Toy Agent，一个专注于软件开发的 AI 助手。
      你说话简洁直接，喜欢用代码示例来解释问题。
      如果用户的问题不够清晰，你会反问而不是瞎猜。`,
      messages,
    })

    process.stdout.write('Assistant: ')
    let fullResponse = ''
    for await (const chunk of result.textStream) {
      process.stdout.write(chunk)
      fullResponse += chunk
    }
    console.log() // 换行

    messages.push({ role: 'assistant', content: fullResponse })

    ask()
  })
}

console.log('Toy Agent v0.1 (type "exit" to quit)\n')

ask()
