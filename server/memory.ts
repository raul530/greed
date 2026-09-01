import fs from 'node:fs'
import path from 'node:path'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { ask } from './ask'
import * as opt from './optmem'
import { truncate } from './util'

/**
 * Memória persistente POR PROJETO, sobre o OptMem de Victor Taelin
 * (github.com/VictorTaelin/OptMem).
 *
 * O problema que isso resolve: antes, toda memória acumulada era despejada
 * inteira no system prompt de toda sessão. O custo crescia linearmente com o
 * que o projeto lembrava, e o teto de 250 itens apagava as memórias mais
 * antigas em silêncio — caro E amnésico ao mesmo tempo.
 *
 * O OptMem inverte isso. O log é append-only e nunca é editado: nada se perde.
 * Sobre ele existe uma árvore de compressão binária, e o que entra no contexto
 * é uma COBERTURA desse log — o presente literal, o passado em resumos cada vez
 * mais grossos. O contexto tem tamanho constante sobre uma memória infinita.
 *
 * O que o Greed acrescenta: aqui a memória é automática. O agente não roda
 * `memo note` nem paga as compressões — quem extrai e quem comprime é um modelo
 * barato (haiku), do lado do servidor, entre os turnos. O agente principal só
 * recebe o contexto pronto, e tem `recall`/`zoom` para descer no detalhe quando
 * o resumo não bastar.
 */

const MEM_DIR = path.join(process.cwd(), 'data', 'memory')
fs.mkdirSync(MEM_DIR, { recursive: true })

const dirFor = (projectId: string): string => path.join(MEM_DIR, projectId)
const legacyFile = (projectId: string): string => path.join(MEM_DIR, `${projectId}.json`)

/** compressões pagas numa passada; o resto fica para a próxima */
const NAP_BUDGET = 200

// ---------------------------------------------------------------- fila

// Serializa as escritas por projeto: dois turnos simultâneos do mesmo projeto
// não podem receber o mesmo id no log.
const chains = new Map<string, Promise<void>>()
function enqueue(projectId: string, task: () => Promise<void>): Promise<void> {
  const prev = chains.get(projectId) ?? Promise.resolve()
  const next = prev.then(task).catch((err) => console.error('[greed] memory:', err))
  chains.set(projectId, next)
  return next
}

// ---------------------------------------------------------------- migração

interface LegacyItem {
  topic?: string
  text: string
  ts?: number
}

const isoDate = (ts: number): string => new Date(ts).toISOString().slice(0, 10)

/**
 * Importa a memória antiga (`<projectId>.json`) para o log, uma vez, em ordem
 * cronológica. O arquivo original é renomeado, não apagado: se algo der errado
 * na conversão, a memória bruta continua ali.
 */
function migrate(projectId: string): void {
  const legacy = legacyFile(projectId)
  if (!fs.existsSync(legacy)) return
  const dir = dirFor(projectId)
  if (opt.logLen(dir) > 0) return // já importado noutra rodada
  let items: LegacyItem[]
  try {
    const parsed = JSON.parse(fs.readFileSync(legacy, 'utf8')) as unknown
    items = Array.isArray(parsed) ? (parsed as LegacyItem[]) : []
  } catch {
    return
  }
  const cfg = opt.readConfig(dir)
  const rows = items
    .filter((i) => i && typeof i.text === 'string' && i.text.trim())
    .sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))
    .map((i) => {
      const topic = (i.topic ?? '').trim()
      // o tópico vira prefixo: mantém o agrupamento que já tínhamos e continua
      // achável por regex no `recall`
      const text = topic && topic.toLowerCase() !== 'geral' ? `${topic}: ${i.text}` : i.text
      return { date: isoDate(i.ts ?? Date.now()), text: opt.clampBytes(text, cfg.ENTRY_CHARS) }
    })
  if (rows.length > 0) opt.logAppend(dir, rows)
  fs.renameSync(legacy, `${legacy}.imported`)
  console.log(`[greed] memória do projeto ${projectId}: ${rows.length} itens importados para o OptMem`)
}

const ready = new Set<string>()

/** Garante a pasta da memória, a migração do formato antigo e as compressões pendentes. */
function ensure(projectId: string): string {
  const dir = dirFor(projectId)
  if (!ready.has(projectId)) {
    ready.add(projectId)
    opt.init(dir)
    try {
      migrate(projectId)
    } catch (err) {
      console.error('[greed] memory migrate:', err)
    }
    if (opt.pendingCount(dir, opt.logLen(dir)) > 0) void enqueue(projectId, () => nap(projectId))
  }
  return dir
}

// ---------------------------------------------------------------- render

/**
 * A memória do projeto como o agente a recebe: a cobertura do log, do mais
 * antigo ao mais recente. `#a-b` é um resumo de várias memórias; `#n` é uma
 * memória literal.
 */
export function renderMemory(projectId: string, projectName: string): string | null {
  const dir = ensure(projectId)
  const cfg = readBudget(dir)
  const lines = opt.coverLines(dir, cfg)
  if (lines.length === 0) return null
  const total = opt.logLen(dir)
  let out = `# Memória do projeto "${projectName}" (OptMem, mantida automaticamente pelo Greed)\n`
  out +=
    `${total} memórias registradas, apresentadas em ${lines.length} linhas: as recentes literais, ` +
    'as antigas comprimidas em resumos. Uma linha `#a-b` é o resumo do intervalo de memórias a..b — ' +
    'nada foi perdido, só condensado.\n' +
    'Use como contexto de fundo. Se algo divergir do estado atual dos arquivos/repositório, o estado ' +
    'atual prevalece.\n' +
    'Para abrir um resumo em detalhe use a tool `mcp__greed_memory__memory_zoom` com o id do bloco ' +
    '(ex.: "16-31"); para procurar um fato específico em toda a memória use ' +
    '`mcp__greed_memory__memory_recall` com uma regex.\n\n'
  for (const l of lines) {
    out += l.raw ? `#${l.lo} ${l.text}\n` : `#${l.lo}-${l.hi - 1} ${l.text}\n`
  }
  return out
}

function readBudget(dir: string): number {
  return opt.readConfig(dir).WAKE_LINES
}

export function memoryLength(projectId: string): number {
  return opt.logLen(ensure(projectId))
}

export function memorySince(
  projectId: string,
  from: number,
  max = 24,
): { text: string | null; length: number } {
  const dir = ensure(projectId)
  const length = opt.logLen(dir)
  if (from < 0 || length <= from) return { text: null, length }
  const entries = opt.logSlice(dir, Math.max(from, length - max), length)
  if (entries.length === 0) return { text: null, length }
  const skipped = length - from - entries.length
  let out = `# Memória do projeto: ${length - from} fato(s) novo(s) desde o início desta sessão\n`
  out +=
    'Outro chat do mesmo projeto registrou isto enquanto você estava aberto. Vale como contexto de ' +
    'fundo; se divergir do estado atual dos arquivos, o estado atual prevalece.\n'
  if (skipped > 0) out += `(${skipped} mais antigos omitidos — use \`memory_recall\` se precisar)\n`
  out += '\n'
  for (const e of entries) out += `#${e.id} ${e.text}\n`
  return { text: out, length }
}

/** Números da memória de um projeto, para diagnóstico. */
export function memoryStats(projectId: string): {
  total: number
  lines: number
  pending: number
  chars: number
} {
  const dir = ensure(projectId)
  const total = opt.logLen(dir)
  const lines = opt.coverLines(dir, readBudget(dir))
  return {
    total,
    lines: lines.length,
    pending: opt.pendingCount(dir, total),
    chars: lines.reduce((n, l) => n + l.text.length + 12, 0),
  }
}

// ---------------------------------------------------------------- busca

/** Busca literal em toda a memória do projeto, palavra por palavra. */
export function recallMemory(projectId: string, pattern: string): string {
  const dir = ensure(projectId)
  const { hits, lines } = opt.recall(dir, pattern)
  if (hits === 0) return 'Nenhuma memória casa com esse padrão.'
  const head = lines.join('\n')
  return lines.length < hits
    ? `${head}\n\n(${lines.length} mais recentes de ${hits} resultados — refine a regex.)`
    : `${head}\n\n(${hits} resultado${hits > 1 ? 's' : ''}.)`
}

/** Abre um bloco resumido nas suas duas metades, descendo até a memória crua. */
export function zoomMemory(projectId: string, block: string): string {
  const dir = ensure(projectId)
  const [lo, hi] = opt.blockId(block)
  if (lo >= opt.logLen(dir)) return `#${block} está além da memória, que tem ${opt.logLen(dir)} entradas.`
  const out = opt.zoom(dir, lo, hi)
  return out.length > 0 ? out.join('\n') : 'Bloco vazio.'
}

// ---------------------------------------------------------------- extração

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
        topic: String(x.topic ?? '').slice(0, 40),
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
  const raw = await ask(EXTRACT_SYSTEM, prompt)
  return raw ? parseItems(raw) : []
}

// ---------------------------------------------------------------- compressão

const NAP_SYSTEM =
  'Você comprime memórias de um projeto. Responda SOMENTE com a linha comprimida, ' +
  'sem aspas, sem prefixo, sem explicação.'

/**
 * Paga as compressões pendentes: cada bloco vira uma linha só. Os blocos são
 * construídos em ordem, do menor para o maior, então um bloco grande sempre
 * comprime a partir dos dois resumos-filhos, nunca do log cru.
 */
async function nap(projectId: string): Promise<void> {
  const dir = dirFor(projectId)
  const cfg = opt.readConfig(dir)
  let paid = 0
  for (;;) {
    const T = opt.logLen(dir)
    const todo = opt.pending(dir, T, 1)
    if (todo.length === 0) break
    if (paid >= NAP_BUDGET) {
      // deixa o resto para a próxima passada; o render degrada para detalhe
      // fino nesse intervalo enquanto isso, nunca para memória faltando
      setTimeout(() => void enqueue(projectId, () => nap(projectId)), 1_000)
      break
    }
    const [lo, hi] = todo[0]
    const body = opt.napBody(dir, lo, hi)
    if (body === null) break
    const line = await ask(
      NAP_SYSTEM,
      `Comprima as memórias #${lo}-${hi - 1} de um projeto numa ÚNICA linha de no máximo ` +
        `${cfg.ENTRY_CHARS} bytes.\n` +
        'Preserve o que tem efeito duradouro — decisões, preferências, fatos estáveis, nomes — e ' +
        'descarte o resto. Não invente nada. Escreva no mesmo idioma das linhas abaixo.\n\n' +
        `${body}\n`,
      { timeoutMs: 60_000 },
    )
    const clean = line ? opt.clampBytes(line.replace(/^["'`]|["'`]$/g, ''), cfg.ENTRY_CHARS) : ''
    if (!clean) break // modelo indisponível: tenta de novo no próximo turno
    opt.treePut(dir, lo, hi, clean)
    paid++
  }
}

// ---------------------------------------------------------------- captura

/**
 * Captura memórias do último turno e as acrescenta ao log do projeto, depois
 * paga as compressões que vencerem. Fire-and-forget: falhas nunca afetam a
 * sessão.
 */
export function captureTurn(input: {
  projectId: string
  projectName: string
  sessionId: string
  userText: string
  assistantText: string
  /** chamado quando fatos novos entraram na memória do projeto */
  onSaved?: (count: number) => void
}): void {
  const dir = ensure(input.projectId)
  void enqueue(input.projectId, async () => {
    const found = await extract(input.projectName, input.userText, input.assistantText)
    if (found.length > 0) {
      const cfg = opt.readConfig(dir)
      // dedup barato contra o passado recente: o log é append-only, então uma
      // repetição literal é ruído puro, não história
      const recent = new Set(
        opt.logSlice(dir, Math.max(0, opt.logLen(dir) - 200), opt.logLen(dir)).map((e) => norm(e.text)),
      )
      const rows: Array<{ date: string; text: string }> = []
      const date = isoDate(Date.now())
      for (const f of found) {
        const topic = f.topic.trim()
        const text = opt.clampBytes(
          topic && topic.toLowerCase() !== 'geral' ? `${topic}: ${f.text}` : f.text,
          cfg.ENTRY_CHARS,
        )
        const key = norm(text)
        if (!key || recent.has(key)) continue
        recent.add(key)
        rows.push({ date, text })
      }
      if (rows.length > 0) {
        opt.logAppend(dir, rows)
        input.onSaved?.(rows.length)
      }
    }
    await nap(input.projectId)
  })
}

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim()

// ---------------------------------------------------------------- tools

/**
 * As tools que o agente recebe para navegar a memória do projeto. O contexto
 * injetado é uma cobertura comprimida; é por aqui que se recupera o detalhe
 * que o resumo deixou de fora — sem nunca precisar carregar tudo.
 */
export function memoryTools(projectId: string): ReturnType<typeof createSdkMcpServer> {
  return createSdkMcpServer({
    name: 'greed_memory',
    version: '1.0.0',
    tools: [
      tool(
        'memory_recall',
        'Procura uma expressão regular em TODAS as memórias já registradas neste projeto, ' +
          'inclusive as que aparecem comprimidas no contexto. Use quando precisar de um fato ' +
          'específico que o resumo não traz.',
        { pattern: z.string().describe('expressão regular, case-insensitive') },
        async ({ pattern }) => {
          try {
            return { content: [{ type: 'text' as const, text: recallMemory(projectId, pattern) }] }
          } catch (err) {
            return { content: [{ type: 'text' as const, text: (err as Error).message }], isError: true }
          }
        },
      ),
      tool(
        'memory_zoom',
        'Abre um bloco resumido da memória (`#a-b` no contexto) nas suas duas metades, ' +
          'descendo até as memórias literais. Use para expandir um resumo antigo.',
        { block: z.string().describe('id do bloco como aparece no contexto, ex.: "16-31"') },
        async ({ block }) => {
          try {
            return { content: [{ type: 'text' as const, text: zoomMemory(projectId, block) }] }
          } catch (err) {
            return { content: [{ type: 'text' as const, text: (err as Error).message }], isError: true }
          }
        },
      ),
    ],
  })
}

/**
 * Prepara a memória de todos os projetos ao subir o servidor: migra o formato
 * antigo e começa a pagar as compressões. Sem isso, a primeira sessão depois de
 * uma atualização abriria com a árvore vazia e receberia o log cru como
 * fallback — correto, porém mais caro do que precisa ser.
 */
export function warmMemory(projectIds: string[]): void {
  for (const id of projectIds) {
    try {
      ensure(id)
    } catch (err) {
      console.error('[greed] memory warm:', err)
    }
  }
}
