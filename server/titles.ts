import os from 'node:os'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { truncate } from './util'

/** Título imediato, derivado do primeiro prompt (fallback e placeholder). */
export function fallbackTitle(prompt: string): string {
  return truncate(prompt, 48) || 'Novo chat'
}

/**
 * Gera um título curto via Haiku em uma query isolada e descartável.
 * Retorna null em qualquer falha — quem chama mantém o fallback.
 */
export async function generateTitle(firstPrompt: string): Promise<string | null> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), 30_000)
  try {
    const q = query({
      prompt:
        'Gere um título curto (máximo 5 palavras, sem aspas, sem ponto final, no mesmo idioma ' +
        'da mensagem) para uma conversa que começa com a mensagem abaixo. Responda SOMENTE o título.\n\n' +
        truncate(firstPrompt, 500),
      options: {
        cwd: os.tmpdir(),
        model: 'haiku',
        maxTurns: 1,
        tools: [],
        settingSources: [],
        systemPrompt: 'Você gera títulos curtos e descritivos para conversas. Responda apenas o título.',
        persistSession: false,
        abortController: abort,
        env: { ...process.env, ANTHROPIC_API_KEY: undefined },
      },
    })
    for await (const msg of q) {
      if (msg.type === 'result') {
        if (msg.subtype !== 'success') return null
        const title = msg.result.trim().replace(/^["'“”]+|["'“”.]+$/g, '')
        return title ? truncate(title, 60) : null
      }
    }
    return null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
