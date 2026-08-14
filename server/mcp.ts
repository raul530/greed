import fs from 'node:fs'
import path from 'node:path'
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { expandEnvVarsDeep } from './util'

/**
 * Lê o .mcp.json do projeto (formato padrão do Claude Code) e devolve o mapa de
 * servidores pronto para a opção `mcpServers` do SDK, com ${VAR} expandido.
 * Passar explicitamente evita o fluxo de aprovação de servidores de projeto.
 */
export function loadProjectMcpServers(projectPath: string): Record<string, McpServerConfig> {
  const file = path.join(projectPath, '.mcp.json')
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return {}
  }
  try {
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, McpServerConfig> }
    if (!parsed.mcpServers || typeof parsed.mcpServers !== 'object') return {}
    return expandEnvVarsDeep(parsed.mcpServers)
  } catch (err) {
    console.warn(`[bento] .mcp.json inválido em ${file}:`, err)
    return {}
  }
}
