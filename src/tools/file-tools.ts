import type { ToolDefinition } from './tool-registry'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export const readFileTool: ToolDefinition = {
  name: 'read_file',
  description: '读取指定路径的文件内容',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  maxResultChars: 500, // 演示工具只向模型返回较短的文件片段。
  /**
   * 以 UTF-8 编码读取文件。
   *
   * @param input - 读取参数。
   * @param input.path - 相对于当前工作目录或绝对文件路径。
   * @returns 文件的文本内容。
   * @throws 当文件不存在、不可读或路径指向非文件资源时抛出文件系统错误。
   */
  execute: async ({ path }: { path: string }) => {
    return readFileSync(resolve(path), 'utf-8')
  },
}

export const writeFileTool: ToolDefinition = {
  name: 'write_file',
  description: '写入内容到指定文件',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
      content: { type: 'string', description: '要写入的内容' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  isConcurrencySafe: false,
  isReadOnly: false,
  /**
   * 创建缺失的父目录并以 UTF-8 编码写入文件，已有内容会被覆盖。
   *
   * @param input - 写入参数。
   * @param input.path - 相对于当前工作目录或绝对文件路径。
   * @param input.content - 要写入的完整文本内容。
   * @returns 包含写入字符数和目标路径的确认消息。
   * @throws 当目录或文件无法创建、写入时抛出文件系统错误。
   */
  execute: async ({ path, content }: { path: string, content: string }) => {
    const resolved = resolve(path)
    mkdirSync(dirname(resolved), { recursive: true })
    writeFileSync(resolved, content, 'utf-8')
    return `已写入 ${content.length} 字符到 ${path}`
  },
}

export const listDirectoryTool: ToolDefinition = {
  name: 'list_directory',
  description: '列出指定目录下的文件和子目录',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '目录路径，默认为当前目录' },
    },
    required: [],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  /**
   * 列出目录中的直接子项，并标注文件或目录类型。
   *
   * @param input - 列目录参数。
   * @param input.path - 目标目录，默认为当前工作目录。
   * @returns 每行一个子项的目录清单。
   * @throws 当目录不存在、不可读或子项状态无法读取时抛出文件系统错误。
   */
  execute: async ({ path = '.' }: { path?: string }) => {
    const resolved = resolve(path)
    return readdirSync(resolved).map((name) => {
      const stat = statSync(join(resolved, name))
      return `${stat.isDirectory() ? '[DIR]' : '[FILE]'} ${name}`
    }).join('\n')
  },
}

export const editFileTool: ToolDefinition = {
  name: 'edit_file',
  description: '精确替换文件中的指定内容。用 old_string 定位要替换的文本，用 new_string 替换它。不是全量覆写，而是改你指定的部分',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
      old_string: { type: 'string', description: '要被替换的原始文本（必须精确匹配）' },
      new_string: { type: 'string', description: '替换后的新文本' },
    },
    required: ['path', 'old_string', 'new_string'],
    additionalProperties: false,
  },
  isConcurrencySafe: false,
  isReadOnly: false,
  /**
   * 在文件中执行一次精确文本替换，仅当原文本唯一匹配时写回。
   *
   * @param input - 编辑参数。
   * @param input.path - 相对于当前工作目录或绝对文件路径。
   * @param input.old_string - 必须在文件中唯一出现的原文本。
   * @param input.new_string - 用于替换原文本的新内容。
   * @returns 替换确认消息；文件不存在或匹配次数不为一时返回原因说明。
   * @throws 当文件无法读取或写入时抛出文件系统错误。
   */
  execute: async ({ path, old_string, new_string }: { path: string, old_string: string, new_string: string }) => {
    const resolved = resolve(path)
    if (!existsSync(resolved)) {
      return `文件不存在: ${path}`
    }

    const content = readFileSync(resolved, 'utf-8')
    const count = content.split(old_string).length - 1

    if (count === 0) {
      return `未找到匹配内容。请检查 old_string 是否与文件中的文本完全一致（包括空格和换行）`
    }
    if (count > 1) {
      return `找到 ${count} 处匹配，请提供更多上下文让 old_string 唯一`
    }

    const updated = content.replace(old_string, new_string)
    writeFileSync(resolved, updated, 'utf-8')
    return `已替换 ${path} 中的内容（${old_string.length} → ${new_string.length} 字符）`
  },
}

export const fileTools: ToolDefinition[] = [
  readFileTool,
  writeFileTool,
  listDirectoryTool,
  editFileTool,
]
