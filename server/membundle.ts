import type { MemoryBundle, MemoryImportResult } from '../shared/types'
import * as opt from './optmem'

/**
 * A memória de um projeto num arquivo só, para mandar a outra pessoa.
 *
 * O pacote leva o log inteiro e a árvore de resumos já paga. Quem importa num
 * projeto vazio recebe a pasta idêntica à de origem e não gasta uma compressão.
 * Quem importa num projeto que já tem memória recebe só o que falta, no fim do
 * log: ali a árvore de origem não serve (as posições mudam) e o trecho novo é
 * comprimido de novo em segundo plano.
 *
 * Tudo aqui opera sobre uma pasta do OptMem. A fila por projeto fica em
 * memory.ts.
 */

const KIND = 'greed-memory'
const VERSION = 1
/** teto de sanidade: um pacote maior que isso não saiu do Greed */
const MAX_ENTRIES = 500_000

const DATE = /^\d{4}-\d{2}-\d{2}$/
const today = (): string => new Date().toISOString().slice(0, 10)

/** Uma linha de memória tem que ser uma linha: sem quebra, sem controle, no tamanho do registro. */
function cleanText(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return opt.clampBytes(raw.replace(/[\u0000-\u001f\u007f]/g, ' '), opt.ENTRY_TOP)
}

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim()

/** Empacota a memória da pasta: todas as entradas e todo resumo já construído. */
export function exportBundle(dir: string, projectName: string): MemoryBundle {
  const total = opt.logLen(dir)
  const entries = opt.logSlice(dir, 0, total).map((e) => ({ date: e.date, text: e.text }))
  const tree: Record<string, string[]> = {}
  for (let size = 2; size <= total; size *= 2) {
    // o teto corta um resumo gravado depois que o log foi lido
    const level = opt.treeLevel(dir, size, Math.floor(total / size))
    if (level.length === 0) break
    tree[String(size)] = level
  }
  return {
    kind: KIND,
    version: VERSION,
    project: projectName,
    exportedAt: new Date().toISOString(),
    entries,
    tree,
  }
}

/**
 * Valida e saneia um pacote vindo de fora. O arquivo passou por outra máquina e
 * pode ter sido editado à mão, então nada dele é gravado sem passar por aqui.
 */
export function parseBundle(raw: unknown): MemoryBundle {
  if (!raw || typeof raw !== 'object') throw new Error('Arquivo não é uma memória do Greed')
  const b = raw as Record<string, unknown>
  if (b.kind !== KIND) throw new Error('Arquivo não é uma memória do Greed')
  if (b.version !== VERSION) {
    throw new Error(`Memória exportada numa versão que este Greed não lê (${String(b.version)})`)
  }
  if (!Array.isArray(b.entries)) throw new Error('Memória sem entradas')
  if (b.entries.length > MAX_ENTRIES) throw new Error('Memória grande demais')

  const entries: MemoryBundle['entries'] = []
  let intact = true
  for (const item of b.entries as unknown[]) {
    const e = (item ?? {}) as { date?: unknown; text?: unknown }
    const text = cleanText(e.text)
    if (!text) {
      // uma entrada a menos desloca todas as seguintes: a árvore deixa de valer
      intact = false
      continue
    }
    entries.push({ date: typeof e.date === 'string' && DATE.test(e.date) ? e.date : today(), text })
  }
  if (entries.length === 0) throw new Error('Memória vazia: nada a importar')

  const tree: Record<string, string[]> = {}
  if (intact && b.tree && typeof b.tree === 'object') {
    const src = b.tree as Record<string, unknown>
    for (let size = 2; size <= entries.length; size *= 2) {
      const level = src[String(size)]
      if (!Array.isArray(level)) break
      const out: string[] = []
      for (const item of level.slice(0, Math.floor(entries.length / size))) {
        const text = cleanText(item)
        if (!text) break // cada nível é um prefixo denso: um buraco encerra o nível
        out.push(text)
      }
      if (out.length === 0) break
      tree[String(size)] = out
    }
  }

  return {
    kind: KIND,
    version: VERSION,
    project: cleanText(b.project).slice(0, 80) || 'sem nome',
    exportedAt: typeof b.exportedAt === 'string' ? b.exportedAt.slice(0, 40) : '',
    entries,
    tree,
  }
}

/**
 * Grava um pacote já validado na pasta. Pasta vazia: cópia fiel, com a árvore.
 * Pasta com memória: acrescenta só o que ainda não está lá. O log continua
 * append-only nos dois casos, então importar o mesmo arquivo duas vezes não
 * duplica nada.
 */
export function importBundle(dir: string, bundle: MemoryBundle): MemoryImportResult {
  opt.init(dir)
  const before = opt.logLen(dir)

  if (before === 0) {
    opt.logAppend(dir, bundle.entries)
    // do menor nível para o maior, na ordem: é como o treePut espera receber
    for (let size = 2; size <= bundle.entries.length; size *= 2) {
      const level = bundle.tree[String(size)]
      if (!level) break
      for (let k = 0; k < level.length; k++) {
        if (!opt.treePut(dir, k * size, (k + 1) * size, level[k])) break
      }
    }
    const total = opt.logLen(dir)
    return { added: total, skipped: 0, total, pending: opt.pendingCount(dir, total) }
  }

  const seen = new Set(opt.logSlice(dir, 0, before).map((e) => norm(e.text)))
  const rows: MemoryBundle['entries'] = []
  for (const e of bundle.entries) {
    const key = norm(e.text)
    if (seen.has(key)) continue
    seen.add(key)
    rows.push(e)
  }
  if (rows.length > 0) opt.logAppend(dir, rows)
  const total = opt.logLen(dir)
  return {
    added: rows.length,
    skipped: bundle.entries.length - rows.length,
    total,
    pending: opt.pendingCount(dir, total),
  }
}
