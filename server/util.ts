import { randomUUID } from 'node:crypto'

export const uid = () => randomUUID()
export const now = () => Date.now()

export function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`
}

/** Resumo de uma linha do input de uma tool, para chips e pedidos de permissão. */
export function summarizeToolInput(toolName: string, input: unknown): string {
  try {
    if (input == null) return toolName
    if (typeof input !== 'object') return truncate(String(input), 200)
    const obj = input as Record<string, unknown>
    const preferred = [
      'command',
      'file_path',
      'path',
      'url',
      'pattern',
      'query',
      'prompt',
      'description',
      'text',
      'content',
    ]
    for (const key of preferred) {
      const v = obj[key]
      if (typeof v === 'string' && v.trim()) return `${key}: ${truncate(v, 200)}`
    }
    return truncate(JSON.stringify(obj), 200)
  } catch {
    return toolName
  }
}

/** Expande tokens ${VAR} e ${VAR:-default} a partir do ambiente (formato do .mcp.json do Claude Code). */
export function expandEnvVars(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name: string, def?: string) => {
    return process.env[name] ?? def ?? ''
  })
}

export function expandEnvVarsDeep<T>(value: T): T {
  if (typeof value === 'string') return expandEnvVars(value) as unknown as T
  if (Array.isArray(value)) return value.map((v) => expandEnvVarsDeep(v)) as unknown as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = expandEnvVarsDeep(v)
    }
    return out as unknown as T
  }
  return value
}
