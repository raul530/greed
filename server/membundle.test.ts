import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { exportBundle, importBundle, parseBundle } from './membundle'
import * as opt from './optmem'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'greed-membundle-'))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

let seq = 0
const freshDir = (): string => path.join(root, `m${seq++}`)

/** uma memória com `n` entradas e todos os resumos que cabem já construídos */
function seeded(n: number): string {
  const dir = freshDir()
  opt.init(dir)
  opt.logAppend(
    dir,
    Array.from({ length: n }, (_, i) => ({ date: '2026-08-14', text: `Decisão: fato número ${i} é ação` })),
  )
  for (const [lo, hi] of opt.pending(dir, n)) opt.treePut(dir, lo, hi, `resumo de ${lo} a ${hi - 1}`)
  return dir
}

const files = (dir: string): Record<string, string> => {
  const out: Record<string, string> = { LOG: fs.readFileSync(path.join(dir, 'LOG.txt'), 'utf8') }
  for (const f of fs.readdirSync(path.join(dir, 'TREE'))) {
    out[`TREE/${f}`] = fs.readFileSync(path.join(dir, 'TREE', f), 'utf8')
  }
  return out
}

/** o caminho que o arquivo faz de verdade: vira JSON, viaja, volta e é validado */
const viaFile = (dir: string, name = '1043') =>
  parseBundle(JSON.parse(JSON.stringify(exportBundle(dir, name))))

describe('exportar e importar num projeto vazio', () => {
  it('a pasta de destino fica idêntica à de origem, árvore inclusa', () => {
    const src = seeded(37)
    const dst = freshDir()
    const r = importBundle(dst, viaFile(src))
    expect(r).toEqual({ added: 37, skipped: 0, total: 37, pending: 0 })
    expect(files(dst)).toEqual(files(src))
    // e o que o agente recebe no contexto é o mesmo
    expect(opt.coverLines(dst, 8)).toEqual(opt.coverLines(src, 8))
  })

  it('resumo que faltava na origem continua pendente no destino', () => {
    const src = freshDir()
    opt.init(src)
    opt.logAppend(
      src,
      Array.from({ length: 8 }, (_, i) => ({ date: '2026-09-01', text: `fato ${i}` })),
    )
    opt.treePut(src, 0, 2, 'resumo 0-1')
    const dst = freshDir()
    const r = importBundle(dst, viaFile(src))
    expect(r.total).toBe(8)
    expect(r.pending).toBe(opt.pendingCount(src, 8))
    expect(opt.treeGet(dst, 0, 2)).toBe('resumo 0-1')
  })
})

describe('importar num projeto que já tem memória', () => {
  it('entra só o que falta, no fim do log, e o que existia não muda', () => {
    const src = seeded(10)
    const dst = freshDir()
    opt.init(dst)
    opt.logAppend(dst, [
      { date: '2026-10-01', text: 'memória local' },
      { date: '2026-10-02', text: 'decisão: FATO número 3   é ação' }, // mesma coisa, outra caixa e espaços
    ])
    const antes = fs.readFileSync(path.join(dst, 'LOG.txt'))
    const r = importBundle(dst, viaFile(src))
    expect(r).toMatchObject({ added: 9, skipped: 1, total: 11 })
    const depois = fs.readFileSync(path.join(dst, 'LOG.txt'))
    expect(depois.subarray(0, antes.length).equals(antes)).toBe(true)
    // a data de origem viaja junto
    expect(opt.logSlice(dst, 2, 3)[0]).toEqual({ id: 2, date: '2026-08-14', text: 'Decisão: fato número 0 é ação' })
  })

  it('importar o mesmo arquivo de novo não duplica nada', () => {
    const src = seeded(10)
    const dst = freshDir()
    importBundle(dst, viaFile(src))
    const r = importBundle(dst, viaFile(src))
    expect(r).toMatchObject({ added: 0, skipped: 10, total: 10 })
  })
})

describe('parseBundle desconfia do arquivo', () => {
  const ok = { kind: 'greed-memory', version: 1, project: 'x', exportedAt: '', entries: [], tree: {} }

  it('recusa o que não é memória do Greed', () => {
    expect(() => parseBundle(null)).toThrow(/não é uma memória/)
    expect(() => parseBundle([1, 2])).toThrow(/não é uma memória/)
    expect(() => parseBundle({ ...ok, kind: 'outra-coisa' })).toThrow(/não é uma memória/)
    expect(() => parseBundle({ ...ok, version: 2 })).toThrow(/versão/)
    expect(() => parseBundle(ok)).toThrow(/vazia/)
    expect(() => parseBundle({ ...ok, entries: [{ text: '   ' }] })).toThrow(/vazia/)
  })

  it('uma memória é sempre uma linha que cabe no registro', () => {
    const b = parseBundle({
      ...ok,
      entries: [
        { date: '2026-08-14', text: 'linha um\n#99 2026-01-01 linha forjada\u0000' },
        { date: 'ontem', text: 'ç'.repeat(2000) },
      ],
    })
    expect(b.entries[0].text).toBe('linha um #99 2026-01-01 linha forjada')
    expect(b.entries[1].date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(Buffer.byteLength(b.entries[1].text)).toBeLessThanOrEqual(opt.ENTRY_TOP)
    // e grava sem estourar o registro de largura fixa
    const dir = freshDir()
    expect(importBundle(dir, b).total).toBe(2)
    expect(opt.logSlice(dir, 0, 2).map((e) => e.id)).toEqual([0, 1])
  })

  it('entrada descartada invalida a árvore, que seria de outras posições', () => {
    const b = parseBundle({
      ...ok,
      entries: [{ text: 'a' }, { text: '' }, { text: 'b' }, { text: 'c' }],
      tree: { '2': ['resumo a+vazio', 'resumo b+c'] },
    })
    expect(b.entries.map((e) => e.text)).toEqual(['a', 'b', 'c'])
    expect(b.tree).toEqual({})
  })

  it('árvore maior que o log ou com buraco é cortada', () => {
    const b = parseBundle({
      ...ok,
      entries: Array.from({ length: 5 }, (_, i) => ({ text: `f${i}` })),
      tree: { '2': ['r01', 'r23', 'sobra'], '4': ['', 'x'], '8': ['não cabe'] },
    })
    expect(b.tree).toEqual({ '2': ['r01', 'r23'] })
  })
})
