/**
 * OptMem — memória append-only com árvore de compressão binária.
 *
 * Porte fiel do algoritmo de Victor Taelin (github.com/VictorTaelin/OptMem),
 * adaptado para rodar dentro do servidor do Greed, por projeto.
 *
 * A ideia central: o log NUNCA é editado nem apagado. Sobre ele existe uma
 * árvore de merges — o bloco [lo,hi) é a compressão de [lo,mid) e [mid,hi) —
 * e o que entra no contexto é uma COBERTURA desse log escolhida por `cover`:
 * detalhe fino no presente, blocos cada vez maiores conforme envelhece. O
 * resultado é um contexto de tamanho CONSTANTE sobre uma memória infinita.
 *
 * O formato em disco é byte-a-byte o mesmo do OptMem original, então o `memo`
 * de verdade lê esta pasta: `MEMORY_DIR=data/memory/<projectId> memo wake`.
 */

import fs from 'node:fs'
import path from 'node:path'

// Registros são de LARGURA FIXA, então posição É identidade: a memória i mora
// em i*LOG_REC de LOG.txt e o bloco [k*s,(k+1)*s) mora em k*TREE_REC de
// TREE/<s>. O padding custa ~2x em disco e compra O(1) em toda leitura.
const LOG_REC = 320
const TREE_REC = 288

/** blocos até este tamanho comprimem a partir do log cru, não dos resumos */
const RAW_MAX = 16

export const KNOBS = {
  WAKE_LINES: [64, 'o contexto de memória: quantas linhas o wake imprime'],
  ENTRY_CHARS: [280, 'o tamanho máximo de uma memória, em bytes'],
  PART_CHARS: [20000, 'paginação de saída: maior parte, em bytes'],
  PART_LINES: [500, 'paginação de saída: maior parte, em linhas'],
} as const satisfies Record<string, readonly [number, string]>

export type Knob = keyof typeof KNOBS

export interface Config {
  WAKE_LINES: number
  ENTRY_CHARS: number
  PART_CHARS: number
  PART_LINES: number
}

export interface Entry {
  id: number
  date: string
  text: string
}

/** um nó da cobertura: uma memória crua, ou o resumo de um bloco */
export interface CoverLine {
  lo: number
  hi: number
  text: string
  /** true quando é uma memória crua (bloco de tamanho 1) */
  raw: boolean
  /** true quando o resumo ainda não existe e a linha veio de um fallback */
  pending?: boolean
}

// ---------------------------------------------------------------- cover

/**
 * Ladrilha [0,T) com blocos alinhados de potência de dois; mantém um bloco
 * inteiro sse seu tamanho é no máximo `alpha` vezes sua idade. Alpha maior =
 * mais grosso = menos linhas.
 */
function coverAlpha(T: number, alpha: number): Array<[number, number]> {
  let root = 1
  while (root < T) root *= 2
  const out: Array<[number, number]> = []
  const stack: Array<[number, number]> = [[0, root]]
  while (stack.length > 0) {
    const [lo, hi] = stack.pop() as [number, number]
    if (lo >= T) continue
    const size = hi - lo
    if (size > 1 && (hi > T || size > alpha * (T - lo))) {
      const mid = (lo + hi) >> 1
      stack.push([mid, hi])
      stack.push([lo, mid])
    } else {
      out.push([lo, hi])
    }
  }
  out.sort((a, b) => a[0] - b[0])
  return out
}

/**
 * Os blocos que entram no contexto: no máximo `budget` deles, mais finos perto
 * de T. O detalhe decai com a idade, então memórias recentes ficam literais e
 * as antigas colapsam. Se tudo couber, nada é comprimido.
 */
export function cover(T: number, budget: number): Array<[number, number]> {
  if (T <= 0) return []
  if (T <= budget) return Array.from({ length: T }, (_, i) => [i, i + 1] as [number, number])
  let lo = 0
  let hi = 1
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (coverAlpha(T, mid).length > budget) lo = mid
    else hi = mid
  }
  const out = coverAlpha(T, hi)
  // Os tamanhos saltam em potências de dois, então o alpha sozinho pode ficar
  // abaixo do orçamento. O que sobra é gasto no presente, onde o detalhe vale
  // mais: divide sempre o bloco divisível mais recente.
  while (out.length < budget) {
    let idx = -1
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i][1] - out[i][0] > 1) {
        idx = i
        break
      }
    }
    if (idx < 0) break
    const [a, b] = out[idx]
    const mid = (a + b) >> 1
    out.splice(idx, 1, [a, mid], [mid, b])
  }
  return out
}

// ---------------------------------------------------------------- bytes

function clampBytes(text: string, max: number): string {
  let out = text.replace(/\s+/g, ' ').trim()
  if (Buffer.byteLength(out) <= max) return out
  // corta por caractere até caber; o '…' também custa bytes
  while (out.length > 0 && Buffer.byteLength(`${out}…`) > max) out = out.slice(0, -1)
  return `${out}…`
}

function pad(text: string, rec: number): Buffer {
  const b = Buffer.from(text, 'utf8')
  if (b.length > rec - 1) throw new Error(`registro de ${b.length} bytes; o limite é ${rec - 1}`)
  return Buffer.concat([b, Buffer.alloc(rec - 1 - b.length, 0x20), Buffer.from('\n')])
}

function parse(line: string): Entry {
  const s = line.replace(/\s+$/, '')
  const a = s.indexOf(' ')
  const b = s.indexOf(' ', a + 1)
  return { id: Number(s.slice(1, a)), date: s.slice(a + 1, b), text: s.slice(b + 1) }
}

/**
 * Decodifica uma sequência de registros. As fatias são feitas em BYTES e
 * decodificadas uma a uma — fatiar texto já decodificado deslocaria todas as
 * fronteiras depois do primeiro caractere multi-byte.
 */
function records(buf: Buffer): Entry[] {
  const out: Entry[] = []
  for (let i = 0; i + LOG_REC <= buf.length; i += LOG_REC) {
    out.push(parse(buf.subarray(i, i + LOG_REC).toString('utf8')))
  }
  return out
}

// ---------------------------------------------------------------- store

const logPath = (dir: string): string => path.join(dir, 'LOG.txt')
const treePath = (dir: string, size: number): string => path.join(dir, 'TREE', String(size))

function count(file: string, rec: number): number {
  try {
    return Math.floor(fs.statSync(file).size / rec)
  } catch {
    return 0
  }
}

/**
 * Descarta um registro parcial no fim do arquivo, deixado por um crash. Ele
 * nunca foi confirmado. Sem isso, o próximo append cai num offset errado e
 * todo registro seguinte fica desalinhado.
 */
function repair(file: string, rec: number): void {
  let n: number
  try {
    n = fs.statSync(file).size
  } catch {
    return
  }
  if (n % rec !== 0) fs.truncateSync(file, n - (n % rec))
}

/** Cria a pasta da memória se não existir. Idempotente. */
export function init(dir: string): void {
  fs.mkdirSync(path.join(dir, 'TREE'), { recursive: true })
  if (!fs.existsSync(logPath(dir))) fs.writeFileSync(logPath(dir), '')
  if (!fs.existsSync(path.join(dir, 'config'))) writeConfig(dir, {})
}

// ---------------------------------------------------------------- config

/** Lê o `config` no formato do OptMem. Linhas comentadas seguem o padrão. */
export function readConfig(dir: string): Config {
  const out: Config = {
    WAKE_LINES: KNOBS.WAKE_LINES[0],
    ENTRY_CHARS: KNOBS.ENTRY_CHARS[0],
    PART_CHARS: KNOBS.PART_CHARS[0],
    PART_LINES: KNOBS.PART_LINES[0],
  }
  let raw: string
  try {
    raw = fs.readFileSync(path.join(dir, 'config'), 'utf8')
  } catch {
    raw = ''
  }
  for (const line of raw.split('\n')) {
    const clean = line.split('#')[0].trim()
    const eq = clean.indexOf('=')
    if (eq < 0) continue
    const k = clean.slice(0, eq).trim().toUpperCase()
    const v = Number(clean.slice(eq + 1).trim())
    if (k in KNOBS && Number.isInteger(v) && v > 0) out[k as Knob] = v
  }
  // teto do OptMem: uma memória tem que caber nos registros de largura fixa
  const top = Math.min(TREE_REC - 8, LOG_REC - 40)
  if (out.ENTRY_CHARS > top) out.ENTRY_CHARS = top
  const env = Number(process.env.GREED_WAKE_LINES)
  if (Number.isInteger(env) && env > 0) out.WAKE_LINES = env
  return out
}

function writeConfig(dir: string, over: Partial<Config>): void {
  const head = [
    '# Tamanhos do OptMem para esta memória. Linha comentada = segue o padrão',
    '# da ferramenta. Compatível com `memo config` do OptMem original.',
    '',
  ]
  const body = (Object.keys(KNOBS) as Knob[]).map((k) => {
    const [def, what] = KNOBS[k]
    const on = over[k] !== undefined
    return `${on ? '  ' : '# '}${k.padEnd(12)} = ${String(over[k] ?? def).padEnd(6)} # ${what}`
  })
  fs.writeFileSync(path.join(dir, 'config'), `${[...head, ...body].join('\n')}\n`)
}

// ---------------------------------------------------------------- reads

export function logLen(dir: string): number {
  return count(logPath(dir), LOG_REC)
}

/** As memórias [lo,hi) numa leitura só. */
export function logSlice(dir: string, lo: number, hi: number): Entry[] {
  if (hi <= lo) return []
  const fd = fs.openSync(logPath(dir), 'r')
  try {
    const buf = Buffer.alloc((hi - lo) * LOG_REC)
    const n = fs.readSync(fd, buf, 0, buf.length, lo * LOG_REC)
    return records(buf.subarray(0, n))
  } finally {
    fs.closeSync(fd)
  }
}

/** O resumo do bloco [lo,hi), num seek. null se ainda não foi construído. */
export function treeGet(dir: string, lo: number, hi: number): string | null {
  const size = hi - lo
  let fd: number
  try {
    fd = fs.openSync(treePath(dir, size), 'r')
  } catch {
    return null
  }
  try {
    const buf = Buffer.alloc(TREE_REC)
    const n = fs.readSync(fd, buf, 0, TREE_REC, Math.floor(lo / size) * TREE_REC)
    if (n < TREE_REC) return null
    return buf.toString('utf8').replace(/\s+$/, '') || null
  } finally {
    fs.closeSync(fd)
  }
}

// ---------------------------------------------------------------- writes

/**
 * Acrescenta memórias. A ÚNICA forma de LOG.txt mudar. Devolve o primeiro id
 * usado. Os ids saem do tamanho atual do log, então a serialização por projeto
 * (a fila em memory.ts) é o que impede dois turnos de colidirem.
 */
export function logAppend(dir: string, items: Array<{ date: string; text: string }>): number {
  init(dir)
  repair(logPath(dir), LOG_REC)
  const base = logLen(dir)
  const bufs = items.map((it, k) => pad(`#${base + k} ${it.date} ${it.text}`, LOG_REC))
  const fd = fs.openSync(logPath(dir), 'a')
  try {
    fs.writeSync(fd, Buffer.concat(bufs))
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  return base
}

/**
 * Grava o bloco [lo,hi). Os blocos são construídos em ordem, então isso só
 * acrescenta um registro a um arquivo de nível. false se alguém chegou antes.
 */
export function treePut(dir: string, lo: number, hi: number, text: string): boolean {
  const size = hi - lo
  const file = treePath(dir, size)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  repair(file, TREE_REC)
  if (count(file, TREE_REC) !== Math.floor(lo / size)) return false
  const fd = fs.openSync(file, 'a')
  try {
    fs.writeSync(fd, pad(text, TREE_REC))
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  return true
}

/**
 * Esquece o bloco [lo,hi) e tudo construído a partir dele, truncando cada
 * nível de volta àquele ponto. O log nunca é tocado, então nada se perde: a
 * próxima compressão reconstrói.
 */
export function treeDrop(dir: string, lo: number, hi: number): Array<[number, number]> {
  const gone: Array<[number, number]> = []
  let size = hi - lo
  const T = logLen(dir)
  while (size <= T) {
    const file = treePath(dir, size)
    const k = Math.floor(lo / size)
    const n = count(file, TREE_REC)
    if (n > k) {
      for (let i = k; i < n; i++) gone.push([i * size, (i + 1) * size])
      fs.truncateSync(file, k * TREE_REC)
    }
    size *= 2
  }
  return gone
}

// ---------------------------------------------------------------- naps

/**
 * Blocos que podem ser construídos e ainda não foram, do menor para o maior.
 * Cada arquivo de nível guarda um prefixo denso, então o tamanho dele diz
 * exatamente até onde aquele nível chegou: um stat por nível, nunca um scan.
 */
export function pending(dir: string, T: number, limit?: number): Array<[number, number]> {
  const todo: Array<[number, number]> = []
  for (let size = 2; size <= T; size *= 2) {
    const have = count(treePath(dir, size), TREE_REC)
    for (let k = have; k < Math.floor(T / size); k++) {
      todo.push([k * size, (k + 1) * size])
      if (limit && todo.length >= limit) return todo
    }
  }
  return todo
}

export function pendingCount(dir: string, T: number): number {
  let n = 0
  for (let size = 2; size <= T; size *= 2) {
    n += Math.max(0, Math.floor(T / size) - count(treePath(dir, size), TREE_REC))
  }
  return n
}

/** O material que alimenta a compressão de [lo,hi): as memórias cruas, ou os dois resumos-filhos. */
export function napBody(dir: string, lo: number, hi: number): string | null {
  if (hi - lo <= RAW_MAX) {
    return logSlice(dir, lo, hi)
      .map((e) => `  #${e.id} ${e.date} ${e.text}`)
      .join('\n')
  }
  const mid = (lo + hi) >> 1
  const halves: string[] = []
  for (const [a, b] of [
    [lo, mid],
    [mid, hi],
  ] as Array<[number, number]>) {
    const s = treeGet(dir, a, b)
    if (s === null) return null // metade ainda não assentou; nada a fazer agora
    halves.push(`  #${a}-${b - 1} ${s}`)
  }
  return halves.join('\n')
}

// ---------------------------------------------------------------- wake

/**
 * A cobertura do log pronta para virar texto: recentes literais, antigas
 * resumidas. Se um resumo ainda não existe (compressão em andamento), desce
 * na árvore e usa o detalhe que houver — degrada em excesso de linhas, nunca
 * em memória faltando, e se cura sozinho quando a compressão termina.
 */
export function coverLines(dir: string, budget: number): CoverLine[] {
  const T = logLen(dir)
  if (T === 0) return []
  const out: CoverLine[] = []
  const cap = budget * 4 // guarda contra um fallback patológico
  const emit = (lo: number, hi: number, fallback: boolean): void => {
    if (out.length >= cap) return
    if (hi - lo === 1) {
      const [e] = logSlice(dir, lo, hi)
      if (e) out.push({ lo, hi, text: e.text, raw: true, ...(fallback ? { pending: true } : {}) })
      return
    }
    const s = treeGet(dir, lo, hi)
    if (s !== null) {
      out.push({ lo, hi, text: s, raw: false, ...(fallback ? { pending: true } : {}) })
      return
    }
    const mid = (lo + hi) >> 1
    emit(lo, mid, true)
    emit(mid, hi, true)
  }
  for (const [lo, hi] of cover(T, budget)) emit(lo, hi, false)
  return out
}

// ---------------------------------------------------------------- lookup

/** Busca literal (regex) em todas as memórias já registradas, das mais novas para trás. */
export function recall(dir: string, pattern: string, max = 40): { hits: number; lines: string[] } {
  let re: RegExp
  try {
    re = new RegExp(pattern, 'i')
  } catch (err) {
    throw new Error(`regex inválida: ${(err as Error).message}`)
  }
  const T = logLen(dir)
  const lines: string[] = []
  let hits = 0
  const CHUNK = 512
  for (let end = T; end > 0; end -= CHUNK) {
    const start = Math.max(0, end - CHUNK)
    const batch = logSlice(dir, start, end)
    for (let i = batch.length - 1; i >= 0; i--) {
      const e = batch[i]
      const line = `#${e.id} ${e.date} ${e.text}`
      if (!re.test(line)) continue
      hits++
      if (lines.length < max) lines.push(line)
    }
  }
  return { hits, lines }
}

/** Abre um nó da árvore nas suas duas metades — resumo, ou a memória crua na folha. */
export function zoom(dir: string, lo: number, hi: number): string[] {
  const T = logLen(dir)
  const mid = (lo + hi) >> 1
  const out: string[] = []
  for (const [a, b] of [
    [lo, mid],
    [mid, hi],
  ] as Array<[number, number]>) {
    if (a >= T) continue
    if (b - a === 1) {
      const [e] = logSlice(dir, a, b)
      if (e) out.push(`#${e.id} ${e.date} ${e.text}`)
    } else {
      out.push(`#${a}-${b - 1} ${treeGet(dir, a, b) ?? '(ainda não comprimido)'}`)
    }
  }
  return out
}

/**
 * Interpreta `<lo>-<hi>` como wake imprime: inclusivo nas duas pontas, e um
 * bloco de verdade — intervalo alinhado de potência de dois. Sem a checagem de
 * forma, `4-5` e `5-6` leriam o mesmo registro.
 */
export function blockId(s: string): [number, number] {
  const m = /^(\d+)-(\d+)$/.exec(s.trim())
  if (!m) throw new Error(`'${s}' não é um id de bloco. Copie do contexto, ex.: 16-31.`)
  const lo = Number(m[1])
  const hi = Number(m[2]) + 1
  const n = hi - lo
  if (n < 2 || (n & (n - 1)) !== 0 || lo % n !== 0) {
    throw new Error(`${s} não é um bloco. Use um id como 0-1, 8-15, 16-31.`)
  }
  return [lo, hi]
}

export { clampBytes, ENTRY_TOP }
const ENTRY_TOP = Math.min(TREE_REC - 8, LOG_REC - 40)
