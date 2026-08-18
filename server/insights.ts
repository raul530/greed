// De onde saiu o consumo das últimas 24 h.
//
// O endpoint de limites só devolve percentual, então token tem que vir de outro
// lugar: os transcripts que o Claude Code grava em ~/.claude/projects/**.jsonl.
// Cada linha de assistant traz timestamp, modelo, sessão, cwd e o usage completo.
// É tudo local e aproximado: cobre só esta máquina, não claude.ai nem outro
// dispositivo.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import type { InsightBucket, InsightsReport, UsageRow } from '../shared/types'

const ROOT = path.join(os.homedir(), '.claude', 'projects')
/** folga sobre a janela pedida: um arquivo pode ter parado de crescer antes do corte */
const SCAN_SLACK_MS = 6 * 60 * 60 * 1000
/** teto do cache de arquivos já lidos; passou disso, esvazia e lê de novo */
const CACHE_MAX = 400
/**
 * Peso relativo por tipo de token (referência pública da Anthropic): saída custa
 * ~5x a entrada, escrita de cache ~1,25x e leitura de cache ~0,1x. Serve pra
 * ordenar quem pesa, não pra estimar preço em dinheiro.
 */
const WEIGHT = { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 }
/** acima disso a janela conta como contexto longo */
const LONG_CONTEXT = 150_000

interface Entry {
  ts: number
  model: string
  sessionId: string
  cwd: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** tamanho da janela naquela chamada */
  context: number
}

function weigh(e: Entry): number {
  return (
    e.input * WEIGHT.input +
    e.output * WEIGHT.output +
    e.cacheWrite * WEIGHT.cacheWrite +
    e.cacheRead * WEIGHT.cacheRead
  )
}

// ── leitura dos transcripts, com cache por arquivo ───────────────────────────

interface CachedFile {
  mtimeMs: number
  size: number
  entries: Entry[]
}
const cache = new Map<string, CachedFile>()

function listTranscripts(
  now: number,
  scanMs: number,
): { file: string; mtimeMs: number; size: number }[] {
  const out: { file: string; mtimeMs: number; size: number }[] = []
  let dirs: fs.Dirent[]
  try {
    dirs = fs.readdirSync(ROOT, { withFileTypes: true })
  } catch {
    return out // sem ~/.claude/projects: nada a relatar
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    const dir = path.join(ROOT, d.name)
    let files: string[]
    try {
      files = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const name of files) {
      if (!name.endsWith('.jsonl')) continue
      const file = path.join(dir, name)
      try {
        const st = fs.statSync(file)
        if (now - st.mtimeMs <= scanMs) out.push({ file, mtimeMs: st.mtimeMs, size: st.size })
      } catch {
        // arquivo sumiu no meio da varredura
      }
    }
  }
  return out
}

/**
 * Extrai as chamadas de um transcript. São dezenas de MB no total, então só
 * viram JSON as linhas que têm mesmo um usage de assistant.
 */
async function parseFile(file: string): Promise<Entry[]> {
  const entries: Entry[] = []
  const stream = fs.createReadStream(file, { encoding: 'utf8' })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of rl) {
      if (line.length < 40) continue
      if (!line.includes('"usage"') || !line.includes('"assistant"')) continue
      let row: {
        type?: string
        timestamp?: string
        sessionId?: string
        cwd?: string
        message?: {
          model?: string
          usage?: {
            input_tokens?: number
            output_tokens?: number
            cache_read_input_tokens?: number
            cache_creation_input_tokens?: number
          }
        }
      }
      try {
        row = JSON.parse(line)
      } catch {
        continue // linha truncada (arquivo sendo escrito agora)
      }
      const u = row.message?.usage
      if (row.type !== 'assistant' || !u || !row.timestamp) continue
      // '<synthetic>' são mensagens que o Claude Code fabrica, sem chamada real
      const model = row.message?.model ?? 'desconhecido'
      if (model.startsWith('<')) continue
      const ts = Date.parse(row.timestamp)
      if (!Number.isFinite(ts)) continue
      const input = u.input_tokens ?? 0
      const cacheRead = u.cache_read_input_tokens ?? 0
      const cacheWrite = u.cache_creation_input_tokens ?? 0
      if (input + cacheRead + cacheWrite + (u.output_tokens ?? 0) === 0) continue
      entries.push({
        ts,
        model,
        sessionId: row.sessionId ?? path.basename(file, '.jsonl'),
        cwd: row.cwd ?? '',
        input,
        output: u.output_tokens ?? 0,
        cacheRead,
        cacheWrite,
        context: input + cacheRead + cacheWrite,
      })
    }
  } finally {
    rl.close()
    stream.destroy()
  }
  return entries
}

async function collect(now: number, windowMs: number): Promise<Entry[]> {
  // a varredura acompanha a janela pedida: 7 d não pode olhar só o que mexeu hoje
  const files = listTranscripts(now, windowMs + SCAN_SLACK_MS)
  if (cache.size > CACHE_MAX) cache.clear()
  const out: Entry[] = []
  for (const f of files) {
    const hit = cache.get(f.file)
    let entries: Entry[]
    if (hit && hit.mtimeMs === f.mtimeMs && hit.size === f.size) {
      entries = hit.entries
    } else {
      entries = await parseFile(f.file)
      cache.set(f.file, { mtimeMs: f.mtimeMs, size: f.size, entries })
    }
    const cut = now - windowMs
    for (const e of entries) if (e.ts >= cut) out.push(e)
  }
  return out
}

// ── agregação ────────────────────────────────────────────────────────────────

function rank(
  entries: Entry[],
  keyOf: (e: Entry) => string | null,
  labelOf: (key: string, e: Entry) => string,
  limit: number,
): UsageRow[] {
  const acc = new Map<string, { label: string; weight: number; tokens: number; calls: number }>()
  for (const e of entries) {
    const key = keyOf(e)
    if (key == null) continue
    const cur = acc.get(key) ?? { label: labelOf(key, e), weight: 0, tokens: 0, calls: 0 }
    cur.weight += weigh(e)
    cur.tokens += e.input + e.output + e.cacheRead + e.cacheWrite
    cur.calls += 1
    acc.set(key, cur)
  }
  const total = [...acc.values()].reduce((a, b) => a + b.weight, 0)
  return [...acc.values()]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit)
    .map((r) => ({
      label: r.label,
      share: total > 0 ? Math.round((r.weight / total) * 100) : 0,
      tokens: r.tokens,
      calls: r.calls,
    }))
}

/** nome curto pra pasta de trabalho */
function projectLabel(cwd: string): string {
  if (!cwd) return 'sem pasta'
  return path.basename(cwd) || cwd
}

/** 'claude-opus-4-8' → 'opus 4.8' */
function modelLabel(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(id)
  if (!m) return id
  return `${m[1]} ${m[2]}${m[3] ? `.${m[3]}` : ''}`
}

export async function buildInsights(
  cards: Map<string, { title: string; projectName: string }>,
  windowMs: number,
  now = Date.now(),
): Promise<InsightsReport> {
  const entries = await collect(now, windowMs)
  if (entries.length === 0) {
    return {
      generatedAt: now,
      windowMs,
      calls: 0,
      tokens: 0,
      byChat: [],
      byProject: [],
      byModel: [],
      characteristics: [],
    }
  }

  const totalWeight = entries.reduce((a, e) => a + weigh(e), 0)
  const tokens = entries.reduce((a, e) => a + e.input + e.output + e.cacheRead + e.cacheWrite, 0)

  // característica: quanto do peso rodou com a janela já grande
  const longWeight = entries.filter((e) => e.context > LONG_CONTEXT).reduce((a, e) => a + weigh(e), 0)
  const cacheRead = entries.reduce((a, e) => a + e.cacheRead, 0)
  const rawInput = entries.reduce((a, e) => a + e.input + e.cacheWrite + e.cacheRead, 0)
  const output = entries.reduce((a, e) => a + e.output, 0)

  const characteristics: InsightBucket[] = [
    {
      label: `${Math.round((longWeight / totalWeight) * 100)}% do consumo rodou acima de 150k de contexto`,
      hint: 'Sessão longa custa mais mesmo com cache. Fechar o card e abrir outro corta a janela.',
    },
    {
      label: `${Math.round((cacheRead / Math.max(1, rawInput)) * 100)}% da entrada veio de cache`,
      hint: 'Leitura de cache custa ~10x menos que entrada nova. Quanto maior, melhor.',
    },
    {
      label: `${output.toLocaleString('pt-BR')} tokens de saída`,
      hint: 'Saída é o token mais caro do lote, ~5x a entrada. É o que o modelo escreveu.',
    },
  ]

  return {
    generatedAt: now,
    windowMs,
    calls: entries.length,
    tokens,
    byChat: rank(
      entries,
      (e) => e.sessionId,
      (key, e) => {
        const card = cards.get(key)
        if (card) return `${card.projectName} · ${card.title}`
        // sessão do terminal, não card do Greed: o id curto separa uma da outra
        return `${projectLabel(e.cwd)} · claude code ${key.slice(0, 6)}`
      },
      6,
    ),
    byProject: rank(
      entries,
      (e) => e.cwd,
      (_key, e) => projectLabel(e.cwd),
      6,
    ),
    byModel: rank(
      entries,
      (e) => e.model,
      (key) => modelLabel(key),
      6,
    ),
    characteristics,
  }
}
