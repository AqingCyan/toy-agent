import type { ModelMessage } from 'ai'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const SESSION_DIR = '.sessions'

/** 会话文件中的单条消息记录。 */
export interface SessionEntry {
  /** 记录类型，用于过滤其他 JSONL 记录。 */
  type: 'message'
  /** 消息写入时的 ISO 8601 时间。 */
  timestamp: string
  /** 本条记录保存的模型上下文消息。 */
  message: ModelMessage
}

/** 使用当前工作目录下的 JSONL 文件同步持久化模型消息。 */
export class SessionStore {
  private dir: string
  private sessionId: string

  /**
   * 创建会话存储，并确保共享的会话目录存在。
   *
   * @param sessionId - 用于生成会话文件名的会话标识。
   * @throws 当会话目录无法创建时，透传文件系统错误。
   */
  constructor(sessionId: string) {
    this.sessionId = sessionId
    this.dir = SESSION_DIR
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true })
    }
  }

  /** @returns 当前会话对应的 JSONL 文件路径。 */
  private get filePath(): string {
    return join(this.dir, `${this.sessionId}.jsonl`)
  }

  /**
   * 将一条模型消息追加为独立的 JSONL 记录。
   *
   * @param message - 要持久化的模型消息。
   * @throws 当消息无法序列化或会话文件无法写入时抛出错误。
   */
  append(message: ModelMessage): void {
    const entry: SessionEntry = {
      type: 'message',
      timestamp: new Date().toISOString(),
      message,
    }
    appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, 'utf-8')
  }

  /**
   * 按输入顺序追加多条模型消息。
   *
   * @param messages - 要持久化的模型消息列表。
   * @throws 当任意消息无法序列化或写入时抛出错误。
   */
  appendAll(messages: ModelMessage[]): void {
    for (const msg of messages) {
      this.append(msg)
    }
  }

  /**
   * 按文件顺序读取 `type` 为 `message` 的可解析 JSONL 记录。
   *
   * @returns 匹配记录的 `message` 字段；文件不存在或为空时返回空数组。
   * @throws 当已存在的会话文件无法读取时，透传文件系统错误。
   */
  load(): ModelMessage[] {
    if (!existsSync(this.filePath)) {
      return []
    }

    const content = readFileSync(this.filePath, 'utf-8').trim()
    if (!content) {
      return []
    }

    const messages: ModelMessage[] = []
    for (const line of content.split('\n')) {
      if (!line.trim()) {
        continue
      }

      try {
        const entry: SessionEntry = JSON.parse(line)
        if (entry.type === 'message') {
          messages.push(entry.message)
        }
      }
      catch {
        // 单条损坏记录不应阻止其余会话内容恢复。
      }
    }
    return messages
  }

  /** @returns 当前会话文件是否存在。 */
  exists(): boolean {
    return existsSync(this.filePath)
  }

  /**
   * 统计 `load()` 返回的会话消息数量。
   *
   * @returns 可解析且 `type` 为 `message` 的记录数。
   * @throws 当已存在的会话文件无法读取时，透传文件系统错误。
   */
  getMessageCount(): number {
    return this.load().length
  }
}
