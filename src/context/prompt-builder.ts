/** 构建系统提示时由各提示管道共享的运行时信息。 */
export interface PromptContext {
  /** 当前向模型公开的工具数量。 */
  toolCount: number
  /** 尚未发现的延迟工具摘要，用于向模型提示可搜索能力；没有时为空字符串。 */
  deferredToolSummary: string
  /** 已恢复到当前上下文中的历史消息数量。 */
  sessionMessageCount: number
  /** 当前会话标识。 */
  sessionId: string
}

/**
 * 根据提示上下文生成一个提示片段。
 *
 * @param ctx - 当前提示上下文。
 * @returns 提示片段；返回 `null` 表示本次不启用该片段。
 */
type PipeFn = (ctx: PromptContext) => string | null

/** 按注册顺序组合可选的系统提示片段。 */
export class PromptBuilder {
  private pipes: Array<{ name: string, fn: PipeFn }> = []

  /**
   * 注册一条提示管道。
   *
   * @param name - 用于调试输出的管道名称。
   * @param fn - 根据提示上下文生成片段的函数。
   * @returns 当前构建器实例，便于链式注册。
   */
  pipe(name: string, fn: PipeFn) {
    this.pipes.push({ name, fn })
    return this
  }

  /**
   * 执行所有管道，并拼接其中启用的提示片段。
   *
   * @param ctx - 传给每条管道的提示上下文。
   * @returns 以空行分隔的系统提示；没有启用的片段时返回空字符串。
   */
  build(ctx: PromptContext): string {
    const sections: string[] = []
    for (const { fn } of this.pipes) {
      const result = fn(ctx)
      if (result !== null) {
        sections.push(result)
      }
    }
    return sections.join('\n\n')
  }

  /**
   * 执行所有管道，并在控制台输出各片段的启用状态和字符数。
   *
   * @param ctx - 传给每条管道的提示上下文。
   */
  debug(ctx: PromptContext): void {
    console.log('\n=== Prompt Pipe Debug ===')
    for (const { name, fn } of this.pipes) {
      const result = fn(ctx)
      const status = result !== null
        ? `[ON] ${result.length} chars`
        : '[OFF]'
      console.log(`  ${name}: ${status}`)
    }
    console.log('========================\n')
  }
}

// 预置提示管道

/**
 * 创建包含 Agent 身份和基础行为约束的提示管道。
 *
 * @returns 始终生成核心规则的提示管道。
 */
export function coreRules(): PipeFn {
  return () => `你是 Toy Agent，一个有工具调用能力的 AI 助手。
你的行为准则：
- 先读文件再修改，不要凭记忆编辑
- 不要加没被要求的功能
- 工具调用失败时，换一个思路而不是重复同样的操作
- 回答要简洁直接`
}

/**
 * 创建按当前可用工具数量生成使用说明的提示管道。
 *
 * @returns 没有可用工具时禁用自身的提示管道。
 */
export function toolGuide(): PipeFn {
  return (ctx) => {
    if (ctx.toolCount === 0) {
      return null
    }
    return `你有 ${ctx.toolCount} 个工具可用。需要操作本地文件时使用内置工具，需要访问外部服务时使用 MCP 工具。`
  }
}

/**
 * 创建用于说明延迟工具发现方式的提示管道。
 *
 * @returns 没有延迟工具摘要时禁用自身的提示管道。
 */
export function deferredTools(): PipeFn {
  return (ctx) => {
    if (!ctx.deferredToolSummary) {
      return null
    }
    return `如果你需要的工具不在当前列表中，使用 tool_search 工具搜索。${ctx.deferredToolSummary}`
  }
}

/**
 * 创建用于补充已恢复会话信息的提示管道。
 *
 * @returns 没有历史消息时禁用自身的提示管道。
 */
export function sessionContext(): PipeFn {
  return (ctx) => {
    if (ctx.sessionMessageCount === 0) {
      return null
    }
    return `[会话信息] 当前会话 ${ctx.sessionId}，已有 ${ctx.sessionMessageCount} 条历史消息。`
  }
}
