import { useEffect, useRef } from 'react'
import type { PermissionRequest, TranscriptEntry } from '../../../shared/types'
import { Markdown } from './Markdown'

function formatInput(input: unknown): string {
  try {
    const text = typeof input === 'string' ? input : JSON.stringify(input, null, 2)
    return text.length > 1500 ? `${text.slice(0, 1500)}\n…` : text
  } catch {
    return String(input)
  }
}

function Entry({ entry }: { entry: TranscriptEntry }) {
  switch (entry.kind) {
    case 'user':
      return <div className="msg-user">{entry.text}</div>
    case 'assistant':
      return (
        <div className="msg-assistant">
          <Markdown text={entry.text} />
          {entry.streaming && <span className="caret" />}
        </div>
      )
    case 'tool':
      return (
        <div className="tool-line" title={entry.summary}>
          <span className="tool-name">⚙ {entry.name}</span>
          <span className="tool-sum">{entry.summary}</span>
        </div>
      )
    case 'permission': {
      const label =
        entry.decision === 'allow'
          ? '✓ permitido'
          : entry.decision === 'deny'
            ? '✗ negado'
            : '⏳ aguardando decisão'
      return (
        <div className={`perm-line ${entry.decision ?? 'pending'}`} title={entry.summary}>
          {label} — {entry.toolName}
        </div>
      )
    }
    case 'info':
      return <div className="info-line">{entry.text}</div>
    case 'error':
      return <div className="error-line">{entry.text}</div>
    default:
      return null
  }
}

interface Props {
  entries: TranscriptEntry[]
  permissions: PermissionRequest[]
  working: boolean
  onPermission: (requestId: string, behavior: 'allow' | 'deny') => void
}

export function Transcript({ entries, permissions, working, onPermission }: Props) {
  const ref = useRef<HTMLDivElement | null>(null)
  const stick = useRef(true)

  const onScroll = () => {
    const el = ref.current
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  // cola no fim enquanto o usuário não rolou para cima
  useEffect(() => {
    const el = ref.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  })

  return (
    <div className="transcript" ref={ref} onScroll={onScroll}>
      {entries.map((e) => (
        <Entry key={e.id} entry={e} />
      ))}
      {working && permissions.length === 0 && (
        <div className="thinking" aria-label="trabalhando">
          <span />
          <span />
          <span />
        </div>
      )}
      {permissions.map((permission) => (
        <div className="perm-panel" key={permission.id}>
          <div className="perm-head">
            🔐 Pedido de permissão: <b>{permission.toolName}</b>
          </div>
          <pre className="perm-body">{formatInput(permission.input)}</pre>
          <div className="perm-actions">
            <button className="allow" onClick={() => onPermission(permission.id, 'allow')}>
              Permitir
            </button>
            <button className="deny" onClick={() => onPermission(permission.id, 'deny')}>
              Negar
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
