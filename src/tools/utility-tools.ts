import type { Server } from 'node:http'
import type { ToolDefinition } from './tool-registry'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, resolve } from 'node:path'

export const weatherTool: ToolDefinition = {
  name: 'get_weather',
  description: '查询指定城市的天气信息',
  parameters: {
    type: 'object',
    properties: {
      city: { type: 'string', description: '城市名称，如"北京"、"上海"' },
    },
    required: ['city'],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  /**
   * 查询内置的示例天气数据。
   *
   * @param input - 查询参数。
   * @param input.city - 要查询的城市名称。
   * @returns 已配置城市的天气描述，或暂无数据的提示。
   */
  execute: async ({ city }: { city: string }) => {
    const data: Record<string, string> = {
      北京: '晴，15-25°C，东南风 2 级',
      上海: '多云，18-22°C，西南风 3 级',
      深圳: '阵雨，22-28°C，南风 2 级',
    }
    return data[city] || `${city}：暂无数据`
  },
}

export const calculatorTool: ToolDefinition = {
  name: 'calculator',
  description: '计算数学表达式的结果。当用户提问涉及数学运算时使用',
  parameters: {
    type: 'object',
    properties: {
      expression: { type: 'string', description: '数学表达式，如 "2 + 3 * 4"' },
    },
    required: ['expression'],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  /**
   * 执行 JavaScript 数学表达式并格式化计算结果。
   *
   * @param input - 计算参数。
   * @param input.expression - 要计算的表达式。
   * @returns 计算结果，表达式无法执行时返回失败提示。
   */
  execute: async ({ expression }: { expression: string }) => {
    try {
      // 仅用于演示；new Function 会执行输入代码，不应处理不可信内容。
      const result = new Function(`return ${expression}`)()
      return `${expression} = ${result}`
    }
    catch {
      return `无法计算: ${expression}`
    }
  },
}

let previewServer: Server | null = null

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.tsx': 'application/javascript; charset=utf-8',
  '.ts': 'application/javascript; charset=utf-8',
  '.jsx': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
}

export const startPreviewTool: ToolDefinition = {
  name: 'start_preview',
  description: '启动 app/ 目录的预览服务器，让浏览器能访问生成的网页应用。生成应用文件后必须立即调用此工具',
  parameters: {
    type: 'object',
    properties: {
      port: { type: 'number', description: '端口号，默认 8080' },
    },
    required: [],
    additionalProperties: false,
  },
  isConcurrencySafe: false,
  isReadOnly: false,
  /**
   * 启动单例静态服务器，以当前工作目录下的 `app/` 作为文件路径基准。
   * 当前路径检查使用字符串前缀，不能作为严格的目录隔离边界。
   *
   * @param input - 预览参数。
   * @param input.port - 监听端口，默认为 8080。
   * @returns 按当前分支推断的状态提示；复用单例或端口占用时不会验证实际监听地址。
   * @throws 当服务器因端口占用之外的原因监听失败时抛出错误。
   */
  execute: async ({ port = 8080 }: { port?: number } = {}) => {
    const root = resolve('app')
    if (!existsSync(root)) {
      return '错误：app/ 目录不存在，请先用 write_file 生成应用文件'
    }

    if (previewServer) {
      return `预览服务器已在运行 → http://localhost:${port}`
    }

    previewServer = createServer((req, res) => {
      const urlPath = (req.url?.split('?')[0] || '/').replace(/\/$/, '/index.html')
      const filePath = join(root, urlPath === '/' ? '/index.html' : urlPath)
      try {
        if (!filePath.startsWith(root)) {
          res.writeHead(403)
          res.end('Forbidden')
          return
        }
        const content = readFileSync(filePath)
        res.writeHead(200, {
          'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
          'Cache-Control': 'no-cache',
          'Access-Control-Allow-Origin': '*',
        })
        res.end(content)
      }
      catch {
        res.writeHead(404)
        res.end('Not Found')
      }
    })

    return new Promise<string>((resolve, reject) => {
      previewServer!.once('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
          resolve(`端口 ${port} 已被占用，预览可能已经在跑了`)
        }
        else {
          reject(err)
        }
      })
      previewServer!.listen(port, () => {
        resolve(`✓ 预览服务器已启动 → http://localhost:${port}（点击 WebContainer 的 Preview 标签查看）`)
      })
    })
  },
}

export const utilityTools: ToolDefinition[] = [
  weatherTool,
  calculatorTool,
  startPreviewTool,
]
