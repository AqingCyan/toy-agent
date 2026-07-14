import type { ModelMessage } from 'ai'
import type { PromptContext } from './context/prompt-builder'
import type { ToolDefinition } from './tools'
import process from 'node:process'
import { createInterface } from 'node:readline'
import { createOpenAI } from '@ai-sdk/openai'
import { agentLoop } from './agent/loop'
import { estimateTokens, microCompact, summarize } from './context/compressor'
import {
  coreRules,
  deferredTools,
  PromptBuilder,
  sessionContext,
  toolGuide,
} from './context/prompt-builder'
import { SessionStore } from './session/store'
import { allTools, MCPClient, ToolRegistry } from './tools'
import 'dotenv/config'

// Kimi 提供 OpenAI 兼容接口；请求未显式配置时关闭思考模式。
const kimi = createOpenAI({
  baseURL: 'https://api.moonshot.cn/v1',
  apiKey: process.env.DASHSCOPE_API_KEY,
  /**
   * 为模型请求补充默认的思考模式配置。
   *
   * @param input - Fetch 请求目标。
   * @param init - Fetch 请求选项。
   * @returns 兑现为底层 Fetch 响应的 Promise。
   */
  fetch: async (input, init) => {
    if (typeof init?.body === 'string') {
      const body = JSON.parse(init.body) as Record<string, unknown>
      body.thinking ??= { type: 'disabled' }
      return fetch(input, { ...init, body: JSON.stringify(body) })
    }
    return fetch(input, init)
  },
})
const model = kimi.chat('kimi-k2.6')

/** 触发上下文分层压缩的 Token 估算阈值。 */
const COMPACTION_TOKEN_THRESHOLD = 1000

/** 一次压缩检查后的上下文状态和统计。 */
interface CompactionCheckResult {
  /** 可继续传给模型的消息列表。 */
  messages: ModelMessage[]
  /** 当前最新摘要；未压缩时保留传入值。 */
  summary: string
  /** 本次是否因超过阈值而执行了分层压缩流程。 */
  triggered: boolean
  /** 执行压缩检查时的 Token 估算值。 */
  beforeTokens: number
  /** 分层压缩流程结束后的 Token 估算值。 */
  afterTokens: number
  /** 微压缩中被清理输出的工具消息数量。 */
  cleared: number
  /** 被 LLM 摘要替换的原始消息数量。 */
  compressedCount: number
}

/**
 * 在上下文超过统一阈值时先清理旧工具输出，再摘要较早对话。
 *
 * @param messages - 当前模型上下文。
 * @param summary - 上一次压缩生成的摘要。
 * @returns 原样或压缩后的上下文、摘要和统计。
 */
async function compactIfNeeded(messages: ModelMessage[], summary: string): Promise<CompactionCheckResult> {
  const beforeTokens = estimateTokens(messages)
  // 上下文未超过阈值时保留原消息和已有摘要，不调用摘要模型。
  if (beforeTokens <= COMPACTION_TOKEN_THRESHOLD) {
    return {
      messages,
      summary,
      triggered: false,
      beforeTokens,
      afterTokens: beforeTokens,
      cleared: 0,
      compressedCount: 0,
    }
  }

  // 第一层先低成本清理较早的工具输出，第二层再用 LLM 摘要较早对话。
  const microResult = microCompact(messages)
  const summaryResult = await summarize(model, microResult.messages, summary)

  return {
    messages: summaryResult.messages,
    summary: summaryResult.summary,
    triggered: true,
    beforeTokens,
    afterTokens: estimateTokens(summaryResult.messages),
    cleared: microResult.cleared,
    compressedCount: summaryResult.compressedCount,
  }
}

// 注册表统一管理工具定义、执行策略和 MCP 客户端生命周期。
const registry = new ToolRegistry()
registry.register(...allTools)

const toolSearchTool: ToolDefinition = {
  name: 'tool_search',
  description: '获取延迟工具的完整定义。传入工具名（从系统提示的延迟工具列表中选取），返回该工具的完整参数 Schema',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '工具名，如 "mcp__github__list_issues"。支持逗号分隔多个工具名' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  /**
   * 查找延迟工具，并将匹配项标记为后续模型调用可用。
   *
   * @param input - 工具查询参数。
   * @param input.query - 一个工具名，或以逗号分隔的多个工具名。
   * @returns 兑现为匹配工具元数据或未匹配提示的 Promise。
   */
  execute: async ({ query }: { query: string }) => {
    const results = registry.searchTools(query)
    if (results.length === 0) {
      return `没有找到匹配 "${query}" 的工具`
    }
    return results.map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }))
  },
}

registry.register(toolSearchTool)

/**
 * 在环境允许时尝试启动并注册 GitHub MCP 工具。
 *
 * 连接失败只会记录提示，不会中止 CLI 初始化。
 *
 * @returns 完成环境检查和 MCP 连接尝试后解决的 Promise。
 */
async function connectMCP() {
  const githubToken = process.env.GITHUB_PERSONAL_ACCESS_TOKEN

  let canSpawn = true
  try {
    const { execSync } = await import('node:child_process')
    execSync('echo test', { stdio: 'ignore' })
  }
  catch {
    canSpawn = false
  }

  if (githubToken && canSpawn) {
    console.log('\n 连接 Github MCP server...')
    try {
      const client = new MCPClient('npx', ['@modelcontextprotocol/server-github'], { GITHUB_PERSONAL_ACCESS_TOKEN: githubToken })
      const tools = await registry.registerMCPServer('github', client)
      console.log(`  已注册 ${tools.length} 个 Github MCP 工具`)
    }
    catch (err) {
      console.log(`  MCP 连接失败: ${err instanceof Error ? err.message : err}`)
      console.log('  降级为 Mock MCP...')
    }
  }

  if (!githubToken) {
    console.log('\n未配置 GITHUB_PERSONAL_ACCESS_TOKEN，跳过 Github MCP 连接')
  }
}

/**
 * 初始化工具和会话，必要时压缩恢复的历史，然后开始等待交互式输入。
 *
 * @returns CLI 完成初始化后解决的 Promise。
 */
async function main() {
  await connectMCP()

  const allCount = registry.getAll().length
  const activeTools = registry.getActiveTools()
  const estimate = registry.countTokenEstimate()

  console.log(`\n=== 工具统计 ===`)
  console.log(`  全部工具: ${allCount} 个`)
  console.log(`  活跃工具: ${activeTools.length} 个（非延迟）`)
  console.log(`  延迟工具: ${allCount - activeTools.length} 个`)
  console.log(`  Token 估算: ~${estimate.active} (活跃) + ~${estimate.deferred} (延迟)`)

  const isContinue = process.argv.includes('--continue')
  const sessionId = 'default'
  const store = new SessionStore(sessionId)

  let messages: ModelMessage[] = []
  // 摘要仅保存在当前进程内，供后续多次 LLM 压缩增量合并。
  let summary = ''

  if (isContinue && store.exists()) {
    messages = store.load()
    console.log(`\n[Session] 恢复会话 "${sessionId}"，${messages.length} 条历史消息`)

    // 会话文件保存的是未压缩原始历史，首次模型请求前需先检查恢复后的上下文。
    const compaction = await compactIfNeeded(messages, summary)
    messages = compaction.messages
    summary = compaction.summary

    if (compaction.triggered) {
      console.log(`[Compaction] 恢复历史超过 ~${COMPACTION_TOKEN_THRESHOLD} tokens，清理 ${compaction.cleared} 个工具结果，摘要 ${compaction.compressedCount} 条消息`)
      console.log(`[Compaction] ~${compaction.beforeTokens} → ~${compaction.afterTokens} tokens`)
    }
  }
  else {
    console.log(`\n[Session] 新会话 "${sessionId}"`)
  }

  const builder = new PromptBuilder()
    .pipe('coreRules', coreRules())
    .pipe('toolGuide', toolGuide())
    .pipe('deferredTools', deferredTools())
    .pipe('sessionContext', sessionContext())

  const promptCtx: PromptContext = {
    toolCount: registry.getActiveTools().length,
    deferredToolSummary: registry.getDeferredToolSummary(),
    sessionMessageCount: messages.length,
    sessionId,
  }

  const SYSTEM = builder.build(promptCtx)

  builder.debug(promptCtx)

  const rl = createInterface({ input: process.stdin, output: process.stdout })

  /**
   * 处理一轮用户输入，持久化新增消息，并在上下文过长时执行分层压缩。
   * 非退出输入处理完成后会继续注册下一轮等待。
   */
  function ask() {
    rl.question('\nYou: ', async (input) => {
      const trimmed = input.trim()
      if (!trimmed || trimmed === 'exit') {
        console.log('Good Bye! 👋')
        await registry.closeAllMCP()
        rl.close()
        return
      }

      const userMsg: ModelMessage = { role: 'user', content: trimmed }
      messages.push(userMsg)
      store.append(userMsg)

      // 每次请求模型前统一检查，避免恢复的大历史或上一轮输出直接超出上下文限制。
      const compaction = await compactIfNeeded(messages, summary)
      messages = compaction.messages
      summary = compaction.summary
      if (compaction.triggered) {
        console.log(`\n  [Compaction] ~${compaction.beforeTokens} tokens，清理 ${compaction.cleared} 个工具结果，摘要 ${compaction.compressedCount} 条消息`)
        console.log(`  [Compaction] 压缩后 ~${compaction.afterTokens} tokens`)
      }

      // agentLoop 会原地追加本轮上下文消息，因此只持久化新增部分。
      const beforeLen = messages.length
      await agentLoop(model, registry, messages, SYSTEM)

      const newMessages = messages.slice(beforeLen)
      store.appendAll(newMessages)

      ask()
    })
  }

  console.log('Toy Agent - Agent Loop (type "exit" to quit)\n')
  ask()
}

main().catch(console.error)
