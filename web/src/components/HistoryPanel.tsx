import { useState } from 'react'
import type { SessionMeta } from '../../../shared/types'
import { InlineEdit } from './InlineEdit'

interface Props {
  sessions: SessionMeta[]
  onClose: () => void
  onReopen: (id: string) => void
  onRename: (id: string, title: string) => void
}

function when(ts: number): string {
  return new Date(ts).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function HistoryPanel({ sessions, onClose, onReopen, onRename }: Props) {
  const [editing, setEditing] = useState<string | null>(null)

  return (
    <>
      <div className="drawer-backdrop" onMouseDown={onClose} />
      <aside className="drawer">
        <header>
          <h2>Histórico</h2>
          <button className="icon" onClick={onClose} title="Fechar">
            ✕
          </button>
        </header>
        {sessions.length === 0 ? (
          <p className="drawer-empty">Nenhum chat fechado. Feche um card no ✕ e ele aparece aqui.</p>
        ) : (
          <ul>
            {sessions.map((s) => (
              <li key={s.id}>
                {editing === s.id ? (
                  <InlineEdit
                    className="history-edit"
                    value={s.title}
                    onCommit={(next) => {
                      onRename(s.id, next)
                      setEditing(null)
                    }}
                    onCancel={() => setEditing(null)}
                  />
                ) : (
                  <>
                    <button
                      className="history-item"
                      onClick={() => onReopen(s.id)}
                      title="Reabrir com contexto completo"
                    >
                      <span className="history-title">{s.title}</span>
                      <span className="history-meta">
                        {s.projectName} · {when(s.updatedAt)}
                        {s.status === 'working' && ' · ainda trabalhando'}
                        {s.attention === 'waiting' && ' · ⚠ esperando você'}
                        {s.attention === 'finished' && ' · ✓ terminou'}
                      </span>
                    </button>
                    <button className="icon" title="Renomear" onClick={() => setEditing(s.id)}>
                      ✎
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </aside>
    </>
  )
}
