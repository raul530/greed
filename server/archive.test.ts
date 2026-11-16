import { describe, expect, it } from 'vitest'
import type { SessionMeta } from '../shared/types'
import { ARCHIVE_DAYS_DEFAULT, archiveDays, staleSessions } from './archive'

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000

function chat(id: string, idleDays: number, over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    projectId: 'p',
    projectName: 'P',
    title: id,
    sdkSessionId: null,
    model: null,
    effort: null,
    permissionMode: 'default',
    codebasePath: null,
    profile: null,
    open: true,
    status: 'idle',
    attention: null,
    createdAt: NOW - 30 * DAY,
    updatedAt: NOW - idleDays * DAY,
    lastError: null,
    ...over,
  }
}

const ids = (list: SessionMeta[]): string[] => list.map((s) => s.id)

describe('staleSessions', () => {
  it('pega só o que passou do prazo: 7 dias cravados ainda fica', () => {
    const all = [
      chat('hoje', 0),
      chat('seis', 6),
      chat('sete', 7),
      { ...chat('sete-e-pouco', 7), updatedAt: NOW - 7 * DAY - 1 },
      chat('trinta', 30),
    ]
    expect(ids(staleSessions(all, NOW, 7))).toEqual(['sete-e-pouco', 'trinta'])
  })

  it('quem está trabalhando ou esperando resposta nunca sai', () => {
    const all = [
      chat('working', 30, { status: 'working' }),
      chat('waiting', 30, { status: 'waiting', attention: 'waiting' }),
      chat('parado', 30),
    ]
    expect(ids(staleSessions(all, NOW, 7))).toEqual(['parado'])
  })

  it('card já fechado não é arquivado de novo', () => {
    expect(staleSessions([chat('fechado', 30, { open: false })], NOW, 7)).toEqual([])
  })

  it('resultado não lido não segura o card', () => {
    expect(ids(staleSessions([chat('nao-lido', 30, { attention: 'finished' })], NOW, 7))).toEqual(['nao-lido'])
  })

  it('0 dias desliga', () => {
    expect(staleSessions([chat('velho', 900)], NOW, 0)).toEqual([])
    expect(staleSessions([chat('velho', 900)], NOW, Number.NaN)).toEqual([])
  })

  it('aceita prazo quebrado', () => {
    expect(ids(staleSessions([chat('doze-horas', 0.5), chat('uma-hora', 1 / 24)], NOW, 0.25))).toEqual(['doze-horas'])
  })
})

describe('archiveDays (GREED_ARCHIVE_DAYS)', () => {
  it('sem valor é o padrão de 7', () => {
    expect(ARCHIVE_DAYS_DEFAULT).toBe(7)
    expect(archiveDays(undefined)).toBe(7)
    expect(archiveDays('')).toBe(7)
    expect(archiveDays('  ')).toBe(7)
  })
  it('número vale, 0 desliga', () => {
    expect(archiveDays('30')).toBe(30)
    expect(archiveDays('0.5')).toBe(0.5)
    expect(archiveDays('0')).toBe(0)
  })
  it('valor ilegível ou negativo cai no padrão, não desliga nem arquiva tudo', () => {
    expect(archiveDays('sete')).toBe(7)
    expect(archiveDays('-1')).toBe(7)
    expect(archiveDays('Infinity')).toBe(7)
  })
})
