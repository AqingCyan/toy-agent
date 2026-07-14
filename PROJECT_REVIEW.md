# Toy Agent 项目审查报告

> 审查日期：2026-07-14
> 审查范围：`src/`、项目配置、会话持久化、Agent 循环、上下文压缩、内置工具与 MCP 客户端

## 结论

当前项目适合作为 Toy Agent 或教学演示，但距离稳定、安全的本地 Agent CLI 仍有一些实质问题。风险主要集中在：

- 工具调用失败后的重试可能重复产生副作用
- 上下文压缩可能在摘要前丢失关键工具结果
- 交互阶段异常无法被顶层错误处理捕获
- 新会话与历史会话没有真正隔离
- 本地工具缺少权限、沙箱和审批边界
- 预览服务器存在路径边界和生命周期问题

建议优先修复顺序：

1. 工具重试的幂等性与副作用控制
2. 交互阶段的异常处理和资源清理
3. 上下文压缩的数据保留逻辑
4. 会话隔离与会话管理
5. 工具权限、沙箱和审批机制
6. 自动化测试与工程文档

## 问题清单

### 1. 工具调用重试可能重复执行副作用操作

**严重程度：高**

相关代码：[`src/agent/loop.ts`](src/agent/loop.ts#L45)

当前实现会消费完整的流式响应，并在失败后重试整个步骤。如果流中已经执行了工具，随后才发生网络错误或响应解析错误，重试会再次执行相同工具。

可能受到影响的操作包括：

- `write_file`、`edit_file`
- `bash`
- GitHub MCP 中的创建、修改类操作
- 任何未来接入的有副作用工具

此外，已经写入终端的部分模型文本无法撤回，重试后可能出现重复或拼接错乱的回答。

**建议：**

- 为每次工具调用保存唯一调用 ID 和执行状态
- 已经完成的工具调用在重试时复用结果，不要再次执行
- 将模型请求重试和工具执行重试分开处理
- 对写操作增加幂等键或明确禁止自动重试

### 2. 上下文压缩会在摘要前删除关键工具结果

**严重程度：高**

相关代码：

- [`src/index.ts`](src/index.ts#L85)
- [`src/context/compressor.ts`](src/context/compressor.ts#L53)

压缩流程先执行 `microCompact`，再把清理后的消息传给摘要模型。这意味着较早的 `read_file`、`grep`、`bash` 等工具输出会先被替换成 `[tool result cleared]`，摘要模型已经无法从中提取关键发现。

另一个问题是：一条工具消息可能包含多个工具结果，当前仅根据第一个内容块的工具名决定是否清理整条消息。如果第一个结果来自可清理工具，后续本应保留的工具结果也会一起被清除。

本地定向测试已复现：同一消息中的 `read_file` 和 `web_fetch` 结果，会因为第一个工具是 `read_file` 而同时被清理。

**建议：**

- 先根据原始消息生成摘要，再清理旧工具正文
- 以单个工具结果 part 为单位判断是否清理
- 保留文件路径、错误信息、命令结论和修改结果等结构化元数据
- 为压缩前后信息完整性增加回归测试

### 3. 交互阶段异常绕过顶层错误处理

**严重程度：高**

相关代码：[`src/index.ts`](src/index.ts#L243)

`readline.question` 接收了一个异步回调，但 `readline` 不会等待或接管该 Promise。因此下列操作抛出的异常不会被文件末尾的 `main().catch(console.error)` 捕获：

- `store.append` 或 `store.appendAll`
- `compactIfNeeded`
- `agentLoop`
- 工具或模型请求中的不可重试错误

这可能导致未处理的 Promise rejection、进程异常退出，以及 MCP 或预览服务器未清理。

**建议：**

- 将单轮处理抽成 `handleInput`，在回调中显式 `void handleInput(...).catch(...)`
- 使用 `try/finally` 统一关闭 readline、MCP 客户端和预览服务器
- 增加 `SIGINT`、`SIGTERM` 和未捕获异常的清理流程

### 4. “新会话”仍会追加到旧会话文件

**严重程度：高**

相关代码：

- [`src/index.ts`](src/index.ts#L194)
- [`src/session/store.ts`](src/session/store.ts#L47)

会话 ID 被固定为 `default`。不使用 `--continue` 时，程序只把内存中的 `messages` 初始化为空数组，却不会清空旧文件或生成新的会话 ID。新消息仍然追加到 `.sessions/default.jsonl`。

之后使用 `--continue` 时，会把多个原本互不相关的会话全部恢复到同一上下文。目前工作区中的 `.sessions/default.jsonl` 已有 24 条记录。

**建议：**

- 新会话默认生成唯一 ID
- 提供 `--session <id>`、`--new`、`--list-sessions` 和 `--delete-session` 等能力
- 如果保留固定 `default`，启动新会话时必须显式截断旧记录
- 为会话文件增加版本、元数据和结构校验

### 5. 工具权限和执行边界不足

**严重程度：高（真实环境）**

相关代码：

- [`src/tools/utility-tools.ts`](src/tools/utility-tools.ts#L37)
- [`src/tools/file-tools.ts`](src/tools/file-tools.ts#L5)
- [`src/tools/shell-tools.ts`](src/tools/shell-tools.ts#L4)
- [`src/tools/search-tools.ts`](src/tools/search-tools.ts#L135)

`calculator` 使用 `new Function` 执行模型提供的表达式，因此可以运行任意 JavaScript，而不仅是数学表达式。本地测试已确认表达式可以访问 Node.js 的 `process` 对象。

同时存在以下边界缺失：

- 文件工具可解析绝对路径和 `..`，没有限制在工作区内
- Shell 工具可执行任意命令，没有审批或命令策略
- 网页抓取工具允许访问任意 URL，缺少内网地址和本机地址限制
- `isReadOnly` 目前主要是元数据，没有形成真正的授权策略

这些行为在本地教学项目中可以作为演示，但如果接入不可信网页、外部 MCP 或真实凭证，容易受到提示注入和任意代码执行影响。

**建议：**

- 使用安全数学表达式解析器替代 `new Function`
- 将文件操作限制在明确的工作区根目录
- 为写文件、执行命令、访问敏感网络和 MCP 写操作增加用户审批
- 为工具定义风险等级、允许范围和超时策略

### 6. 预览服务器路径检查可以被绕过

**严重程度：中高**

相关代码：[`src/tools/utility-tools.ts`](src/tools/utility-tools.ts#L117)

当前使用 `filePath.startsWith(root)` 判断请求路径是否位于 `app/` 中。字符串前缀不能构成可靠的目录边界。

例如，根目录为 `/workspace/app` 时，请求路径 `/../app-private/secrets.txt` 会被解析为 `/workspace/app-private/secrets.txt`，但该路径仍以 `/workspace/app` 开头，因此能够通过当前检查。

**建议：**

- 使用 `relative(root, filePath)` 判断结果是否以 `..` 开头或为绝对路径
- 规范化并解码 URL 后再执行边界检查
- 拒绝空字节、反斜杠和异常编码路径

### 7. 预览服务器缺少正确的生命周期管理

**严重程度：中**

相关代码：[`src/tools/utility-tools.ts`](src/tools/utility-tools.ts#L107)

主要问题包括：

- 启动后没有停止预览服务器的工具或统一清理入口
- 用户输入 `exit` 后，HTTP Server 可能继续占用事件循环，导致进程不退出
- 端口被占用时 Promise 返回提示，但 `previewServer` 仍可能保留为无效实例
- 已启动后传入其他端口，会返回新的端口地址，但实际服务器仍监听旧端口
- `.ts`、`.tsx`、`.jsx` 被直接作为 JavaScript 返回，浏览器无法执行未经转换的 TypeScript 或 JSX

**建议：**

- 增加 `stop_preview` 或统一资源管理器
- 只在 `listening` 成功后保存服务器状态
- 保存并返回实际监听端口
- 仅提供静态 HTML/CSS/JS，或接入真正的构建和开发服务器

### 8. 并行工具结果可能关联到错误调用

**严重程度：中**

相关代码：[`src/agent/loop.ts`](src/agent/loop.ts#L41)

当前只使用一个 `lastToolCall` 保存最近一次工具调用。当模型在一个步骤中发出多个工具调用时，工具结果可能以不同顺序完成，代码会把结果错误地记录到最后一次调用上。

这会导致：

- 无进展检测使用了错误的结果哈希
- 某些调用永远没有关联结果
- 循环警告或熔断出现误判、漏判

`tool-result` 本身已经提供 `toolCallId`、`toolName` 和 `input`，应直接使用这些字段关联结果。

### 9. MCP 工具的并发和只读属性存在错误假设

**严重程度：中**

相关代码：[`src/tools/tool-registry.ts`](src/tools/tool-registry.ts#L71)

所有 MCP 工具都被统一标记为：

- `isConcurrencySafe: true`
- `isReadOnly: true`

这没有反映服务端工具的真实行为。未来接入写操作或不支持并发的 MCP 工具时，可能出现竞态条件或错误的权限判断。

此外，[`src/tools/mcp-client.ts`](src/tools/mcp-client.ts#L66) 中的子进程错误只会输出日志，不会立即拒绝正在等待的请求；相关调用通常要等待 15 秒超时。

**建议：**

- 读取并映射 MCP 工具 annotations
- 未知工具默认按非并发安全、有副作用处理
- 子进程发生 `error`、`exit` 或 `close` 时立即拒绝所有 pending 请求
- 检查 `stdin.write` 的失败和背压状态

### 10. 模型配置和环境变量命名错配

**严重程度：中低**

相关代码：

- [`src/index.ts`](src/index.ts#L20)
- [`.env.template`](.env.template#L1)

代码连接的是 Moonshot/Kimi API，却读取名为 `DASHSCOPE_API_KEY` 的环境变量。DashScope 通常代表另一套服务，容易让使用者填入不匹配的密钥并持续遇到鉴权失败。

**建议：**

- 改为语义明确的 `MOONSHOT_API_KEY` 或 `KIMI_API_KEY`
- 在程序初始化时校验必需配置并快速失败
- 将 base URL、模型名称和思考模式改为可配置项

### 11. 网络搜索缺少统一的超时和响应限制

**严重程度：中**

相关代码：[`src/tools/search-tools.ts`](src/tools/search-tools.ts#L31)

Tavily 和 Serper 请求没有设置超时，可能无限等待。网页抓取虽然设置了超时，但会先把完整响应读入内存，再由工具注册表裁剪文本；遇到超大页面或二进制响应时可能占用大量内存。

**建议：**

- 为所有网络请求设置统一超时
- 校验 URL 协议、主机和解析后的 IP
- 限制重定向次数、响应体大小和允许的 Content-Type
- 对 `max_results` 设置合理上下限

## 其他功能与体验问题

- 空输入会被当作 `exit`，用户误按回车会直接退出
- 第 15 步正常完成时，仍可能输出“达到最大步数限制”
- `get_weather` 返回硬编码示例数据，但工具描述看起来像真实天气查询
- `read_file` 默认最多只向模型返回 500 个字符，对较大源码文件过于激进
- 会话摘要只保存在当前进程内，重启后需要重新压缩全部历史
- 系统提示在启动时构建一次，延迟工具被发现后工具数量和提示不会动态更新
- 项目缺少 README、使用说明、架构说明和故障排查文档

## 工程质量与验证结果

### 已执行检查

- `pnpm exec tsc --noEmit`：通过
- `pnpm lint`：失败
- 上下文微压缩定向测试：确认多工具结果会被整条清理
- 计算器定向测试：确认表达式可以访问 Node.js 运行时对象
- 路径边界定向测试：确认字符串前缀判断可被相似目录前缀绕过

### Lint 问题

`package.json` 缺少文件末尾换行，导致 ESLint 报错：

```text
package.json
  32:2  error  Newline required at end of file but not found  style/eol-last
```

### 测试缺口

项目目前没有 `test` 脚本和测试文件。建议至少为以下模块补充测试：

- `agent/loop.ts`：多工具、错误重试、最大步数和 Token 预算
- `agent/loop-detection.ts`：重复调用、乒乓循环和并行结果关联
- `context/compressor.ts`：压缩边界、混合工具结果和增量摘要
- `session/store.ts`：损坏记录、新会话隔离和并发追加
- `tools/tool-registry.ts`：共享锁、独占锁、异常释放和工具发现
- `tools/utility-tools.ts`：路径穿越、端口占用和服务器关闭
- `tools/mcp-client.ts`：进程退出、请求超时和 pending 清理

## 建议迭代计划

### 第一阶段：稳定性

- 修复异步输入回调的错误处理
- 建立统一的资源关闭流程
- 避免工具重试产生重复副作用
- 修复并行工具结果关联

### 第二阶段：上下文和会话

- 调整压缩顺序，保证摘要读取原始工具结果
- 按工具 part 精确清理输出
- 实现真正的新会话和会话选择能力
- 为会话内容增加结构校验和版本管理

### 第三阶段：安全边界

- 移除 `new Function` 计算器
- 限制文件工具工作目录
- 为 Shell、写文件和 MCP 写操作增加审批
- 增加网络访问策略和 SSRF 防护

### 第四阶段：工程化

- 补充单元测试和集成测试
- 将类型检查、lint 和测试接入 CI
- 完善 README、配置说明和安全说明
- 增加模型、服务地址和超时的配置能力

## 审查边界

本次审查以静态代码分析、类型检查、lint 和无副作用的本地定向测试为主。未调用真实模型 API，也未启动或操作真实 GitHub MCP 服务，因此外部服务兼容性、模型行为和真实网络故障场景仍需要单独进行集成验证。
