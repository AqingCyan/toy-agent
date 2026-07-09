import type { ModelMessage } from 'ai'
import type { PromptContext } from './context/prompt-builder'
import type { ToolDefinition } from './tools'
import process from 'node:process'
import { createInterface } from 'node:readline'
import { createOpenAI } from '@ai-sdk/openai'
import { agentLoop } from './agent/loop'
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

// 模型定义
const kimi = createOpenAI({
  baseURL: 'https://api.moonshot.cn/v1',
  apiKey: process.env.DASHSCOPE_API_KEY,
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

// 工具定义：集中注册后，Agent Loop 只依赖注册表，不需要直接关心每个工具的实现细节。
const registry = new ToolRegistry()
registry.register(...allTools)

// 注册 tool_search 元工具
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

// 连接 MCP server
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

  // Session 持久化
  const isContinue = process.argv.includes('--continue')
  const sessionId = 'default'
  const store = new SessionStore(sessionId)

  let messages: ModelMessage[] = []
  if (isContinue && store.exists()) {
    messages = store.load()
    console.log(`\n[Session] 恢复会话 "${sessionId}"，${messages.length} 条历史消息`)
  }
  else {
    console.log(`\n[Session] 新会话 "${sessionId}"`)
  }

  // Prompt Pipe 组装 system prompt
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

  // Debug: 显示 Prompt Pipe 各模块状态
  builder.debug(promptCtx)

  // 简单的交互式命令行定义
  const rl = createInterface({ input: process.stdin, output: process.stdout })

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

      const beforeLen = messages.length
      await agentLoop(model, registry, messages, SYSTEM)

      // 持久化本轮新增的消息（agent loop 会往 messages 里 push assistant/tool 消息）
      const newMessages = messages.slice(beforeLen)
      store.appendAll(newMessages)

      ask()
    })
  }

  console.log('Toy Agent - Agent Loop (type "exit" to quit)\n')
  ask()
}

main().catch(console.error)
