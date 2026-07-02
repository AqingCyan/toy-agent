import type { ToolDefinition } from './tool-registry'
import { fileTools } from './file-tools'
import { searchToolDefinitions } from './search-tools'
import { shellTools } from './shell-tools'
import { utilityTools } from './utility-tools'

export * from './file-tools'
export * from './mcp-client'
export * from './search-tools'
export * from './shell-tools'
export * from './tool-registry'
export * from './utility-tools'

export const allTools: ToolDefinition[] = [
  ...fileTools,
  ...searchToolDefinitions,
  ...shellTools,
  ...utilityTools,
]
