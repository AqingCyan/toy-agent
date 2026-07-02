import type { ToolDefinition } from './tool-registry.js'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import process from 'node:process'
import fg from 'fast-glob'
import TurndownService from 'turndown'

// ── Tavily（自动挡）──────────────────────────────

export const tavilySearchTool: ToolDefinition = {
  name: 'web_search',
  description: '搜索互联网获取最新信息。返回相关网页的标题、链接和内容摘要',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词' },
      max_results: { type: 'number', description: '返回结果数量，默认 5' },
    },
    required: ['query'],
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  maxResultChars: 3000,
  execute: async ({ query, max_results = 5 }: { query: string, max_results?: number }) => {
    const apiKey = process.env.TAVILY_API_KEY
    if (!apiKey) {
      return '[web_search] 未配置 TAVILY_API_KEY，请在 .env 中设置'
    }

    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results,
        include_answer: true,
      }),
    })

    if (!res.ok) {
      return `[web_search] 请求失败: HTTP ${res.status}`
    }

    const data = await res.json() as any
    const lines: string[] = []

    if (data.answer) {
      lines.push(`## AI 摘要\n${data.answer}\n`)
    }

    for (const r of data.results || []) {
      lines.push(`### ${r.title}`)
      lines.push(r.url)
      lines.push(r.content || r.snippet || '')
      lines.push('')
    }

    return lines.join('\n') || '没有找到相关结果'
  },
}

// ── Serper（手动挡）──────────────────────────────

export const serperSearchTool: ToolDefinition = {
  name: 'web_search',
  description: '搜索互联网获取最新信息。返回 Google 搜索结果的标题、链接和摘要',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词' },
      max_results: { type: 'number', description: '返回结果数量，默认 5' },
    },
    required: ['query'],
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  maxResultChars: 3000,
  execute: async ({ query, max_results = 5 }: { query: string, max_results?: number }) => {
    const apiKey = process.env.SERPER_API_KEY
    if (!apiKey) {
      return '[web_search] 未配置 SERPER_API_KEY，请在 .env 中设置'
    }

    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'X-API-KEY': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ q: query, num: max_results }),
    })

    if (!res.ok) {
      return `[web_search] 请求失败: HTTP ${res.status}`
    }

    const data = await res.json() as any
    const lines: string[] = []

    // Knowledge Graph（如果有）
    if (data.knowledgeGraph) {
      const kg = data.knowledgeGraph
      lines.push(`## ${kg.title}`)
      if (kg.description) {
        lines.push(kg.description)
      }
      lines.push('')
    }

    // Organic Results
    for (const r of (data.organic || []).slice(0, max_results)) {
      lines.push(`### ${r.title}`)
      lines.push(r.link)
      lines.push(r.snippet || '')
      lines.push('')
    }

    return lines.join('\n') || '没有找到相关结果'
  },
}

// ── Web Fetch（手动挡配套）──────────────────────────────

export const webFetchTool: ToolDefinition = {
  name: 'web_fetch',
  description: '抓取指定 URL 的网页内容，转换为 Markdown 格式。搭配 web_search 使用——先搜索拿到链接，再用这个工具读取详细内容',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '完整 URL' },
    },
    required: ['url'],
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  maxResultChars: 3000,
  execute: async ({ url }: { url: string }) => {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; SuperAgent/1.0)',
          'Accept': 'text/html,application/xhtml+xml',
        },
        signal: AbortSignal.timeout(15000),
      })

      if (!res.ok) {
        return `抓取失败: HTTP ${res.status}`
      }

      const html = await res.text()
      return htmlToMarkdown(html)
    }
    catch (err: any) {
      return `抓取失败: ${err.message}`
    }
  },
}

export const fetchUrlTool: ToolDefinition = {
  name: 'fetch_url',
  description: '抓取指定 URL 的网页内容并转换为纯文本（自动剥离 HTML 标签）',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '完整 URL，必须以 http:// 或 https:// 开头' },
    },
    required: ['url'],
    additionalProperties: false,
  },
  isConcurrencySafe: true, // 只读、可并发——抓多个 URL 时直接并行
  isReadOnly: true,
  maxResultChars: 1500, // 网页通常很长，截断兜底
  execute: async ({ url }: { url: string }) => {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 SuperAgent' },
        signal: AbortSignal.timeout(10000),
      })
      if (!res.ok) {
        return `请求失败：HTTP ${res.status}`
      }
      const html = await res.text()
      return html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim() || '页面无文本内容'
    }
    catch (err: any) {
      return `抓取失败：${err.message}`
    }
  },
}

export const globTool: ToolDefinition = {
  name: 'glob',
  description: '按模式搜索文件。支持 * 和 ** 通配符，如 "src/**/*.ts" 匹配 src 下所有 TypeScript 文件',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '搜索模式，如 "**/*.ts"、"src/*.json"' },
      path: { type: 'string', description: '搜索起始目录，默认当前目录' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  execute: async ({ pattern, path = '.' }: { pattern: string, path?: string }) => {
    // 从 resolve(path) 指定的目录开始搜索，只找普通文件，跳过 node_modules 和 .git，默认不包含隐藏文件，也不跟随符号链接
    const results = await fg(pattern, {
      cwd: resolve(path),
      ignore: ['node_modules/**', '.git/**'],
      dot: false,
      onlyFiles: true,
      followSymbolicLinks: false,
    })
    if (results.length === 0) {
      return `没有找到匹配 "${pattern}" 的文件`
    }
    return results.sort().join('\n')
  },
}

export const grepTool: ToolDefinition = {
  name: 'grep',
  description: '在文件中搜索匹配指定模式的内容。返回匹配的行号和内容',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '搜索模式（正则表达式）' },
      path: { type: 'string', description: '搜索路径（文件或目录），默认当前目录' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  execute: async ({ pattern, path = '.' }: { pattern: string, path?: string }) => {
    const baseDir = resolve(path)
    const regex = new RegExp(pattern, 'i')
    const matches: string[] = []
    const SKIP = new Set(['node_modules', '.git', 'dist'])
    const BIN_EXT = new Set(['.png', '.jpg', '.gif', '.woff', '.woff2', '.ico', '.lock'])

    function searchFile(filePath: string) {
      if (matches.length >= 50) {
        return
      }
      const ext = filePath.slice(filePath.lastIndexOf('.'))
      if (BIN_EXT.has(ext)) {
        return
      }

      let content: string
      try {
        content = readFileSync(filePath, 'utf-8')
      }
      catch {
        return
      }

      const lines = content.split('\n')
      const rel = relative(baseDir, filePath)

      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          matches.push(`${rel}:${i + 1}: ${lines[i].trimEnd()}`)
          if (matches.length >= 50) {
            return
          }
        }
      }
    }

    function walk(dir: string) {
      if (matches.length >= 50) {
        return
      }

      let entries: string[]
      try {
        entries = readdirSync(dir)
      }
      catch {
        return
      }

      for (const name of entries) {
        if (SKIP.has(name)) {
          continue
        }
        const fullPath = join(dir, name)
        try {
          const stat = statSync(fullPath)
          if (stat.isDirectory()) {
            walk(fullPath)
          }
          else {
            searchFile(fullPath)
          }
        }
        catch {
          /* skip */
        }
      }
    }

    const stat = statSync(baseDir)
    if (stat.isFile()) {
      searchFile(baseDir)
    }
    else {
      walk(baseDir)
    }

    if (matches.length === 0) {
      return `没有找到匹配 "${pattern}" 的内容`
    }
    const suffix = matches.length >= 50 ? '\n... (结果已截断，共 50+ 条匹配)' : ''
    return matches.join('\n') + suffix
  },
}

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
})
turndown.remove(['script', 'style', 'nav', 'footer', 'header', 'iframe'])

function htmlToMarkdown(html: string): string {
  return turndown.turndown(html)
}

// ── 根据环境变量选择搜索后端 ──────────────────────────────

export function pickSearchTool(): ToolDefinition {
  if (process.env.TAVILY_API_KEY) {
    return tavilySearchTool
  }
  if (process.env.SERPER_API_KEY) {
    return serperSearchTool
  }
  // 都没配就返回 tavily 版（会提示配置 API Key）
  return tavilySearchTool
}

export const searchToolDefinitions: ToolDefinition[] = [
  globTool,
  grepTool,
  fetchUrlTool,
  pickSearchTool(),
  webFetchTool,
]
