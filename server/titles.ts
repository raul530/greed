import { ask } from './ask'
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
  const result = await ask(
    'Você gera títulos curtos e descritivos para conversas. Responda apenas o título.',
    'Gere um título curto (máximo 5 palavras, sem aspas, sem ponto final, no mesmo idioma ' +
      'da mensagem) para uma conversa que começa com a mensagem abaixo. Responda SOMENTE o título.\n\n' +
      truncate(firstPrompt, 500),
  )
  if (!result) return null
  const title = result.trim().replace(/^["\'\u201c\u201d]+|["\'\u201c\u201d.]+$/g, '')
  return title ? truncate(title, 60) : null
}
