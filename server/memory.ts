import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { now, truncate } from './util'

// Memória persistente POR PROJETO — cada projeto é um cluster próprio.
// Inspirado no claude-mem: a cada turno, um modelo barato extrai memórias
// duráveis da conversa (compressão), que são acumuladas e reinjetadas no
// system prompt das próximas sessões daquele projeto, agrupadas por tópico.

const MEM_DIR = path.join(process.cwd(), 'data', 'memory')
fs.mkdirSync(MEM_DIR, { recursive: true })

export interface MemoryItem {
  topic: string
  text: string
  ts: number
  sessionId: string
}

/** teto de itens por projeto; ao exceder, as mais antigas são descartadas */
const MAX_ITEMS = 250

function fileFor(projectId: string): string {
  return path.join(MEM_DIR, `${projectId}.json`)
}

function load(projectId: string): MemoryItem[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(fileFor(projectId), 'utf8'))
    return Array.isArray(parsed) ? (parsed as MemoryItem[]) : []
  } catch {
    return []
  }
}

function save(projectId: string, items: MemoryItem[]): void {
  const file = fileFor(projectId)
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(items, null, 2))
  fs.renameSync(tmp, file)
}

// serializa as escritas por projeto para dois turnos simultâneos não se
// sobrescreverem (dois cards do mesmo projeto capturando ao mesmo tempo)
const chains = new Map<string, Promise<void>>()
function enqueue(projectId: string, task: () => Promise<void>): Promise<void> {
  const prev = chains.get(projectId) ?? Promise.resolve()
  const next = prev.then(task).catch((err) => console.error('[greed] memory:', err))
  chains.set(projectId, next)
  return next
}

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim()

/** Renderiza a memória do projeto como markdown agrupado por tópico (ou null se vazia). */
export function renderMemory(projectId: string, projectName: string): string | null {
  const items = load(projectId)
  if (items.length === 0) return null
  const byTopic = new Map<string, string[]>()
  for (const it of items) {
    const topic = (it.topic || 'Geral').trim() || 'Geral'
    const list = byTopic.get(topic) ?? []
    list.push(it.text)
    byTopic.set(topic, list)
  }
  let out = `# Memória do projeto "${projectName}" (mantida automaticamente pelo Greed)\n`
  out +=
    'Notas acumuladas de sessões anteriores neste projeto, agrupadas por tópico. ' +
    'Use como contexto de fundo. Se algo divergir do estado atual dos arquivos/repositório, o estado atual prevalece.\n'
  for (const [topic, texts] of byTopic) {
    out += `\n## ${topic}\n`
    for (const t of texts) out += `- ${t}\n`
  }
  return out
}

interface Extracted {
  topic: string
  text: string
}

function parseItems(raw: string): Extracted[] {
  try {
    const match = raw.match(/\[[\s\S]*\]/)
    if (!match) return []
    const arr = JSON.parse(match[0]) as unknown
    if (!Array.isArray(arr)) return []
    return arr
      .filter(
        (x): x is { topic?: unknown; text: unknown } =>
          !!x && typeof x === 'object' && typeof (x as { text?: unknown }).text === 'string',
      )
      .map((x) => ({
        topic: String(x.topic ?? 'Geral').slice(0, 40),
        text: truncate(String(x.text), 300),
      }))
      .filter((x) => x.text.length > 0)
      .slice(0, 5)
  } catch {
    return []
  }
}

const EXTRACT_SYSTEM =
  'Você extrai memórias duráveis de um projeto a partir de um trecho de conversa entre ' +
  'um usuário e um agente de código. Responda SOMENTE com JSON, sem texto ao redor.'

async function extract(projectName: string, userText: string, assistantText: string): Promise<Extracted[]> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), 30_000)
  try {
    const prompt =
      `Projeto: "${projectName}".\n\n` +
      'Trecho mais recente da conversa:\n\n' +
      `[Usuário]: ${truncate(userText, 1500)}\n\n` +
      `[Agente]: ${truncate(assistantText, 3000)}\n\n` +
      'Extraia de 0 a 5 memórias DURÁVEIS e específicas deste projeto que valham a pena lembrar em ' +
      'conversas futuras: decisões tomadas, preferências do usuário, fatos estáveis do domínio/sistema, ' +
      'entidades e nomes importantes, tarefas em andamento. NÃO inclua segredos, tokens ou senhas; nem ' +
      'detalhes efêmeros ou o texto trivial da própria pergunta. Cada memória deve ser uma frase curta e ' +
      'autocontida, e vir com um "topic" curto (1-3 palavras) para agrupar (ex.: "API", "Clientes", ' +
      '"Deploy", "Preferências"). Responda SOMENTE um array JSON no formato ' +
      '[{"topic":"...","text":"..."}]. Se não houver nada durável, responda [].'
    const q = query({
      prompt,
      options: {
        cwd: os.tmpdir(),
        model: 'haiku',
        maxTurns: 1,
        tools: [],
        settingSources: [],
        systemPrompt: EXTRACT_SYSTEM,
        persistSession: false,
        abortController: abort,
        env: { ...process.env, ANTHROPIC_API_KEY: undefined },
      },
    })
    for await (const msg of q) {
      if (msg.type === 'result') {
        return msg.subtype === 'success' ? parseItems(msg.result) : []
      }
    }
    return []
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Captura memórias do último turno e as acumula na memória do projeto.
 * Fire-and-forget: falhas nunca afetam a sessão.
 */
export function captureTurn(input: {
  projectId: string
  projectName: string
  sessionId: string
  userText: string
  assistantText: string
}): void {
  void enqueue(input.projectId, async () => {
    const found = await extract(input.projectName, input.userText, input.assistantText)
    if (found.length === 0) return
    const items = load(input.projectId)
    const seen = new Set(items.map((i) => norm(i.text)))
    let changed = false
    for (const f of found) {
      const key = norm(f.text)
      if (!key || seen.has(key)) continue
      seen.add(key)
      items.push({ topic: f.topic || 'Geral', text: f.text, ts: now(), sessionId: input.sessionId })
      changed = true
    }
    if (!changed) return
    const trimmed = items.length > MAX_ITEMS ? items.slice(items.length - MAX_ITEMS) : items
    save(input.projectId, trimmed)
  })
}
