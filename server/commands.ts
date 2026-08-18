import { query, type Query } from '@anthropic-ai/claude-agent-sdk'
import { store } from './store'

export interface SlashCmd {
  name: string
  description: string
  argumentHint: string
  /** 'sdk' = o Claude Code resolve; 'greed' = a gente resolve aqui */
  source: 'sdk' | 'greed'
}

interface CachedSet {
  cmds: SlashCmd[]
  at: number
}

/** Comandos do próprio Greed, que o SDK não conhece. */
export const GREED_COMMANDS: SlashCmd[] = [
  {
    name: 'btw',
    description: 'Pergunta rápida em paralelo, sem interromper o turno que está rodando',
    argumentHint: '<pergunta>',
    source: 'greed',
  },
  {
    name: 'preview',
    description: 'Abre o preview do html desta sessão',
    argumentHint: '',
    source: 'greed',
  },
]

/** Comandos presos ao terminal do Claude Code: não fazem sentido numa UI web. */
const TERMINAL_ONLY = new Set(['doctor', 'color', 'heapdump', 'exit', 'statusline'])
/** Comandos internos, disparados por servidor/handoff — nunca digitados por gente. */
const HIDDEN = new Set(['__remote-workflow', 'workflow-launch-exec', 'extra-usage'])

const STORE_KEY = 'commands'
const cache = new Map<string, CachedSet>()
const inflight = new Map<string, Promise<SlashCmd[]>>()

function loadDisk(): Record<string, CachedSet> {
  return store.read<Record<string, CachedSet>>(STORE_KEY, {})
}

function saveDisk(all: Record<string, CachedSet>): void {
  store.write(STORE_KEY, all)
}

function clean(raw: { name: string; description?: string; argumentHint?: string }[]): SlashCmd[] {
  const sdk = raw
    .filter((c) => !TERMINAL_ONLY.has(c.name) && !HIDDEN.has(c.name))
    .map((c) => ({
      name: c.name,
      description: c.description ?? '',
      argumentHint: c.argumentHint ?? '',
      source: 'sdk' as const,
    }))
  return [...GREED_COMMANDS, ...sdk]
}

/** Guarda a lista que uma sessão viva já tinha em mãos (custo zero). */
export function remember(cwd: string, raw: { name: string; description?: string }[]): void {
  const set = { cmds: clean(raw), at: Date.now() }
  cache.set(cwd, set)
  const all = loadDisk()
  all[cwd] = set
  saveDisk(all)
}

/** Pega a lista de uma sessão viva sem bloquear o start dela. */
export function rememberFrom(cwd: string, q: Query): void {
  void q
    .supportedCommands()
    .then((cmds) => remember(cwd, cmds))
    .catch(() => {})
}

/**
 * Lista para um cwd. Memória → disco → busca sob demanda (sobe um processo do
 * Claude Code só para perguntar, uma vez por pasta).
 */
export async function commandsFor(cwd: string): Promise<SlashCmd[]> {
  const hit = cache.get(cwd) ?? loadDisk()[cwd]
  if (hit) {
    cache.set(cwd, hit)
    return hit.cmds
  }
  const running = inflight.get(cwd)
  if (running) return running

  const job = (async () => {
    const abort = new AbortController()
    try {
      const q = query({
        prompt: (async function* () {
          // fica aberto só enquanto perguntamos a lista
          await new Promise<void>((resolve) => abort.signal.addEventListener('abort', () => resolve()))
        })() as never,
        options: {
          cwd,
          systemPrompt: { type: 'preset', preset: 'claude_code' },
          settingSources: ['user', 'project', 'local'],
          abortController: abort,
          env: { ...process.env, ANTHROPIC_API_KEY: undefined },
        },
      })
      const cmds = await q.supportedCommands()
      remember(cwd, cmds)
      return clean(cmds)
    } catch {
      return GREED_COMMANDS
    } finally {
      abort.abort()
      inflight.delete(cwd)
    }
  })()
  inflight.set(cwd, job)
  return job
}
