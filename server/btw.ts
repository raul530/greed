import { query } from '@anthropic-ai/claude-agent-sdk'
import type { BtwExchange, SessionMeta, TranscriptEntry } from '../shared/types'
import { envForProfile } from './profiles'
import { truncate } from './util'

/**
 * /btw — pergunta de canto. Roda num processo próprio, com o mesmo cwd e o
 * resumo do que está acontecendo no chat principal, e nunca escreve na fila da
 * sessão: o turno que está rodando segue intocado.
 */

const CONTEXT_ENTRIES = 24
const CONTEXT_CHARS = 700
const HISTORY_KEEP = 6

function digest(entries: TranscriptEntry[]): string {
  const tail = entries.slice(-CONTEXT_ENTRIES)
  const lines: string[] = []
  for (const e of tail) {
    if (e.kind === 'user') lines.push(`[usuário] ${truncate(e.text, CONTEXT_CHARS)}`)
    else if (e.kind === 'assistant') lines.push(`[agente] ${truncate(e.text, CONTEXT_CHARS)}`)
    else if (e.kind === 'tool') lines.push(`[tool] ${e.name} — ${truncate(e.summary, 160)}`)
    else if (e.kind === 'error') lines.push(`[erro] ${truncate(e.text, 200)}`)
  }
  return lines.join('\n')
}

function systemFor(session: SessionMeta, entries: TranscriptEntry[]): string {
  return [
    `Você é a "pergunta de canto" (/btw) do Greed, dentro da sessão "${session.title}" do projeto "${session.projectName}".`,
    'O agente principal pode estar no meio de um turno. Você NÃO interfere nele: não edite arquivos, não rode comandos que mudem o repositório, não commite. Leia o que precisar para responder.',
    'Responda curto e direto, em português, no tom de quem está do lado explicando. Sem preâmbulo.',
    '',
    '# O que está acontecendo no chat principal',
    digest(entries) || '(sem histórico ainda)',
  ].join('\n')
}

export interface BtwRunner {
  ask(question: string): Promise<string>
}

/** Uma rodada de /btw: sobe o processo, pergunta, devolve o texto e encerra. */
export async function askBtw(
  session: SessionMeta,
  cwd: string,
  entries: TranscriptEntry[],
  history: BtwExchange[],
  question: string,
): Promise<string> {
  const abort = new AbortController()
  const past = history
    .slice(-HISTORY_KEEP)
    .map((h) => `P: ${h.question}\nR: ${truncate(h.answer, 400)}`)
    .join('\n\n')
  const prompt = past ? `${past}\n\nP: ${question}` : question

  const q = query({
    prompt: (async function* () {
      yield {
        type: 'user' as const,
        message: { role: 'user' as const, content: prompt },
        parent_tool_use_id: null,
      }
      // segura o stream aberto até a resposta terminar
      await new Promise<void>((resolve) => abort.signal.addEventListener('abort', () => resolve()))
    })() as never,
    options: {
      cwd,
      ...(session.model ? { model: session.model } : {}),
      systemPrompt: { type: 'preset', preset: 'claude_code', append: systemFor(session, entries) },
      settingSources: ['user', 'project', 'local'],
      // pergunta de canto não mexe em nada: só leitura
      allowedTools: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      abortController: abort,
      env: envForProfile(session.profile),
    },
  })

  let answer = ''
  try {
    for await (const msg of q) {
      if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if (block.type === 'text') answer += block.text
        }
      }
      if (msg.type === 'result') break
    }
  } finally {
    abort.abort()
  }
  return answer.trim() || '(sem resposta)'
}
