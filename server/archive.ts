import type { SessionMeta } from '../shared/types'

/**
 * Arquivamento automático: chat parado há mais de N dias sai do board e vai
 * para o histórico, como se o card tivesse sido fechado à mão. Nada é apagado,
 * e reabrir pelo histórico traz o chat de volta com o contexto inteiro.
 *
 * Aqui fica só a regra, sem estado: quem aplica é o SessionManager.
 */

const DAY_MS = 24 * 60 * 60 * 1000

export const ARCHIVE_DAYS_DEFAULT = 7

/** de quanto em quanto tempo o servidor procura chats parados */
export const ARCHIVE_SWEEP_MS = 60 * 60 * 1000

/**
 * Lê `GREED_ARCHIVE_DAYS`: quantos dias parado até arquivar. 0 desliga. Vazio
 * ou ilegível cai no padrão, para um erro de digitação não desligar nem
 * arquivar tudo.
 */
export function archiveDays(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return ARCHIVE_DAYS_DEFAULT
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : ARCHIVE_DAYS_DEFAULT
}

/**
 * Os chats que estão no board, parados, e sem uso há mais de `days` dias.
 * "Uso" é o `updatedAt`: a última vez que algo mudou no chat. Quem está
 * trabalhando ou esperando resposta nunca entra, por mais antigo que seja.
 */
export function staleSessions(sessions: Iterable<SessionMeta>, nowTs: number, days: number): SessionMeta[] {
  if (!(days > 0)) return []
  const limit = days * DAY_MS
  const out: SessionMeta[] = []
  for (const s of sessions) {
    if (s.open && s.status === 'idle' && nowTs - s.updatedAt > limit) out.push(s)
  }
  return out
}
