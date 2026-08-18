import type { FleetSpan } from '../../../../shared/types'
import type { SessionMeta } from '../../../../shared/types'
import { clock, dur } from './useFleet'

interface Props {
  feed: FleetSpan[]
  sessions: Record<string, SessionMeta>
  now: number
}

const KIND_GLYPH: Record<FleetSpan['kind'], string> = {
  tool: '⚙',
  subagent: '⧉',
  task: '⌁',
}

/** as sessões ganham um código curto e estável pra caber na coluna do feed */
function tag(session: SessionMeta | undefined, sessionId: string): string {
  const base = session?.title ?? sessionId
  const letters = base.replace(/[^a-zA-Z0-9]/g, '').toUpperCase()
  return (letters.slice(0, 4) || 'SESS').padEnd(4, '·')
}

export function FleetFeed({ feed, sessions, now }: Props) {
  return (
    <div className="fl-feed">
      {feed.length === 0 && <p className="fl-empty-line">nenhuma operação na janela.</p>}
      {feed.map((s) => {
        const end = s.endedAt ?? now
        const body = s.detail || s.target || ''
        return (
          <div key={s.key} className="fl-feed-row" data-st={s.status} data-kind={s.kind}>
            <span className="fl-feed-time">{clock(s.startedAt)}</span>
            <span
              className="fl-feed-tag"
              data-tip={sessions[s.sessionId]?.title ?? 'sessão encerrada'}
            >
              {tag(sessions[s.sessionId], s.sessionId)}
            </span>
            <span className="fl-feed-glyph">{KIND_GLYPH[s.kind]}</span>
            <span className="fl-feed-name">{s.tool && s.status === 'running' ? s.tool : s.name}</span>
            <span className="fl-feed-body" data-tip={s.result ?? undefined}>
              {body}
            </span>
            <span className="fl-feed-dur">{dur(end - s.startedAt)}</span>
          </div>
        )
      })}
    </div>
  )
}
