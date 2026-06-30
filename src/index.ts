import type { ModelMessage } from 'ai'
import process from 'node:process'
import { createInterface } from 'node:readline'
import { createOpenAI } from '@ai-sdk/openai'
import { agentLoop } from './agent-loop'
import { MCPClient } from './mcp-client'
import { ToolRegistry } from './tool-registry'
import { allTools } from './tools'
import 'dotenv/config'

const SYSTEM_PROMPT = `你是 Toy Agent，一个有工具调用能力的 AI 助手。
  你有内置工具和 MCP 工具可用。MCP 工具以 mcp__ 开头，如 mcp__github__list_issues。
  需要查询 GitHub 信息时，使用 mcp__github__ 前缀的工具。
  需要操作本地文件时，使用内置工具。
  回答要简洁直接。`

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

  // 消息历史
  const messages: ModelMessage[] = []
  // 简单的交互式命令行定义
  const rl = createInterface({ input: process.stdin, output: process.stdout })

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
}

main().catch(console.error)
