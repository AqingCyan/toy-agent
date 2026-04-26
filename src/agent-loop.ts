import type { ModelMessage } from 'ai'
import process from 'node:process'
import { streamText } from 'ai'
import { detect, recordCall, recordResult, resetHistory } from './loop-detection'

const MAX_STEPS = 15

export async function agentLoop(model: any, tools: any, messages: ModelMessage[], system: string) {
  let step = 0
  resetHistory()

  while (step < MAX_STEPS) {
    step++
    console.log(`\n=== Step ${step} ===`)

    const result = streamText({ model, system, messages, tools, maxRetries: 0, onError: () => {} })

    let hasToolCall = false
    let fullText = ''
    let shouldBreak = false
    let lastToolCall: { name: string, input: unknown } | null = null

    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'text-delta':
          process.stdout.write(part.text)
          fullText += part.text
          break
        case 'tool-call':
          hasToolCall = true
          lastToolCall = { name: part.toolName, input: part.input }
          console.log(`\n[调用工具: ${part.toolName}，输入: ${JSON.stringify(part.input)}]`)
          const detection = detect(part.toolName, part.input)
          if (detection.stuck) {
            console.log(`  ${detection.message}`)
            if (detection.level === 'critical') {
              shouldBreak = true
            }
            else {
              messages.push({
                role: 'user' as const,
                content: `[系统提醒] ${detection.message}。请换一个思路解决问题，不要重复同样的操作。`,
              })
            }
          }
          recordCall(part.toolName, part.input)
          break
        case 'tool-result':
          console.log(`\n[工具结果: ${JSON.stringify(part.output)}]`)
          if (lastToolCall) {
            recordResult(lastToolCall.name, lastToolCall.input, part.output)
          }
          break
      }
    }

    if (shouldBreak) {
      console.log('\n[循环检测触发，Agent 已停止]')
      break
    }

    // 拿到这一步的完整结果，追加到消息历史
    const stepMessages = await result.response
    messages.push(...stepMessages.messages)

    // 退出条件：模型没有调用任何工具，说明它认为可以直接回复了
    if (!hasToolCall) {
      if (fullText) {
        console.log()
      }
      break
    }

    // 还有工具调用 → 继续循环，让模型看到工具结果后继续思考
    console.log('  → 模型还在工作，继续下一步...')
  }

  if (step >= MAX_STEPS) {
    console.log(`\n达到最大步骤数 (${MAX_STEPS})，强制退出。`)
  }
}
