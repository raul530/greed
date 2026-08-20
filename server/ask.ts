import os from 'node:os'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { envForProfile } from './profiles'

/**
 * Uma pergunta isolada e descartável a um modelo barato — títulos, descrições
 * de documento, extração e compressão de memória.
 *
 * O detalhe que importa aqui é `disableClaudeAiConnectors`. Sem ele, o CLI
 * busca os conectores MCP da conta claude.ai (Drive, BigQuery, Slack, Notion…)
 * e injeta as definições deles em TODA query, inclusive nestas auxiliares. Medido
 * nesta máquina: 22.417 tokens de entrada por chamada, contra 182 com o flag
 * ligado — 120x. Como essas chamadas acontecem a cada turno, a cada chat novo e
 * a cada documento, era uma fatia enorme do consumo, gasta em ferramentas que
 * uma chamada de uma linha nunca vai usar.
 *
 * O segundo é `maxThinkingTokens: 0`. Sem ele o Haiku "pensa" antes de responder
 * — medido: 10.311 tokens de raciocínio para comprimir DUAS linhas, 91 segundos,
 * $0,053 numa chamada cujo input eram 409 tokens. Nenhuma dessas tarefas precisa
 * de raciocínio estendido: são reescritas curtas de um texto que já está pronto.
 * Com o flag: 119 tokens de saída, 7 segundos, $0,0019. (`effort: 'low'` NÃO
 * resolve — continua gastando ~8.900 tokens pensando.)
 *
 * Só vale para as auxiliares: a sessão principal continua com conectores e
 * raciocínio normais.
 */
export async function ask(
  system: string,
  prompt: string,
  opts: { timeoutMs?: number } = {},
): Promise<string | null> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), opts.timeoutMs ?? 30_000)
  try {
    const q = query({
      prompt,
      options: {
        cwd: os.tmpdir(),
        model: 'haiku',
        maxTurns: 1,
        tools: [],
        settingSources: [],
        mcpServers: {},
        settings: { disableClaudeAiConnectors: true },
        maxThinkingTokens: 0,
        systemPrompt: system,
        persistSession: false,
        abortController: abort,
        env: envForProfile(null),
      },
    })
    for await (const msg of q) {
      if (msg.type === 'result') return msg.subtype === 'success' ? msg.result : null
    }
    return null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
