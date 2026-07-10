import type { ModelMessage } from 'ai'
import type { ToolRegistry } from '../tools'
import process from 'node:process'
import { streamText } from 'ai'
import { detect, recordCall, recordResult, resetHistory } from './loop-detection.js'
import { calculateDelay, isRetryable, sleep } from './retry.js'

const MAX_STEPS = 15
const MAX_RETRIES = 3
const TOKEN_BUDGET = 50000

/**
 * 持续请求模型并消费流式响应，直到模型不再调用工具，或触发严重循环、步数及 Token 限制。
 * 警告级循环只追加提醒；严重循环会在当前流消费完成后退出。可重试错误会重放整个步骤。
 *
 * @param model - AI SDK 兼容的语言模型实例。
 * @param registry - 负责工具格式转换、调度和结果裁剪的工具注册表。
 * @param messages - 会被追加循环检测提醒和模型响应的会话消息数组。
 * @param system - 每轮模型请求使用的系统提示词。
 * @returns Agent 循环结束后完成的 Promise。
 * @throws 步骤处理中的错误不可重试或耗尽重试次数时，抛出原始错误。
 */
export async function agentLoop(
  model: any,
  registry: ToolRegistry,
  messages: ModelMessage[],
  system: string,
) {
  let step = 0
  let totalTokens = 0

  resetHistory()

  while (step < MAX_STEPS) {
    step++
    console.log(`\n--- Step ${step} ---`)

    let hasToolCall = false
    let fullText = ''
    let shouldBreak = false
    let lastToolCall: { name: string, input: unknown } | null = null
    let stepResponse: Awaited<ReturnType<typeof streamText>['response']>
    let stepUsage: Awaited<ReturnType<typeof streamText>['usage']>

    for (let attempt = 1; ; attempt++) {
      try {
        const result = streamText({
          model,
          system,
          tools: registry.toAISDKFormat(),
          messages,
          maxRetries: 0,
          onError: ({ error }) => {
            console.error('\n  [AI 流错误]', error)
          },
        })

        for await (const part of result.fullStream) {
          switch (part.type) {
            case 'text-delta':
              process.stdout.write(part.text)
              fullText += part.text
              break

            case 'tool-call':
              hasToolCall = true
              lastToolCall = { name: part.toolName, input: part.input }
              console.log(`  [调用: ${part.toolName}(${JSON.stringify(part.input)})]`)

              const detection = detect(part.toolName, part.input)
              if (detection.stuck) {
                console.log(`  ${detection.message}`)
                if (detection.level === 'critical') {
                  shouldBreak = true
                }
                else {
                  messages.push({
                    role: 'user' as const,
                    content: `  [系统提醒] ${detection.message}。请换一个思路解决问题，不要重复同样的操作。`,
                  })
                }
              }
              recordCall(part.toolName, part.input)
              break

            case 'tool-result':
              console.log(`  [结果: ${JSON.stringify(part.output)}]`)
              if (lastToolCall) {
                recordResult(lastToolCall.name, lastToolCall.input, part.output)
              }
              break
          }
        }

        stepResponse = await result.response
        stepUsage = await result.usage
        break
      }
      catch (error) {
        if (attempt > MAX_RETRIES || !isRetryable(error as Error)) {
          throw error
        }
        const delay = calculateDelay(attempt)
        console.log(`  [重试] 第 ${attempt}/${MAX_RETRIES} 次失败，${delay}ms 后重试...`)
        await sleep(delay)
        hasToolCall = false
        fullText = ''
        shouldBreak = false
        lastToolCall = null
      }
    }

    if (shouldBreak) {
      console.log('\n  [循环检测触发，Agent 已停止]')
      break
    }

    messages.push(...stepResponse.messages)

    const inp = stepUsage?.inputTokens ?? 0
    const out = stepUsage?.outputTokens ?? 0
    totalTokens += inp + out
    const pct = Math.round(totalTokens / TOKEN_BUDGET * 100)
    console.log(`  [Token] ${totalTokens}/${TOKEN_BUDGET} (${pct}%)`)
    if (totalTokens > TOKEN_BUDGET) {
      console.log('\n  [Token 预算耗尽，强制停止]')
      break
    }

    // 没有工具调用表示模型已经给出最终回复。
    if (!hasToolCall) {
      if (fullText) {
        console.log()
      }
      break
    }

    console.log('  → 继续下一步...')
  }

  if (step >= MAX_STEPS) {
    console.log('\n  [达到最大步数限制，强制停止]')
  }
}
