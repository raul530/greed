import { useEffect, useRef, useState } from 'react'
import type { PermissionRequest, SessionMeta, TranscriptEntry } from '../../../shared/types'
import { Transcript } from './Transcript'

interface Props {
  session: SessionMeta
  entries: TranscriptEntry[]
  permissions: PermissionRequest[]
  index: number
  expanded: boolean
  connected: boolean
  /** retorna true se a mensagem foi enviada (para o input só limpar no sucesso) */
  onSend: (text: string) => boolean
  onInterrupt: () => void
  onClose: () => void
  onToggleExpand: () => void
  onSeen: () => void
  onPermission: (requestId: string, behavior: 'allow' | 'deny') => void
  registerInput: (el: HTMLTextAreaElement | null) => void
}

function StatusDot({ status }: { status: SessionMeta['status'] }) {
  const label = status === 'working' ? 'trabalhando' : status === 'waiting' ? 'esperando você' : 'idle'
  return <span className={`status-dot ${status}`} title={label} />
}

export function SessionCard(props: Props) {
  const { session, entries, permissions, index, expanded, connected } = props
  const [draft, setDraft] = useState('')
  const rootRef = useRef<HTMLElement | null>(null)

  const submit = () => {
    const text = draft.trim()
    if (!text || !connected) return
    if (props.onSend(text)) setDraft('')
  }

  const seen = () => {
    if (session.attention) props.onSeen()
  }

  // se a atenção acender enquanto o usuário já está com o card focado, apaga sozinha
  useEffect(() => {
    if (!session.attention) return
    const active = document.activeElement
    if (active && rootRef.current?.contains(active)) props.onSeen()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.attention])

  const cls = [
    'card',
    session.status,
    session.attention ? `attn-${session.attention}` : '',
    expanded ? 'expanded' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <section
      ref={rootRef}
      className={cls}
      onMouseDown={seen}
      onFocusCapture={seen}
      data-session={session.id}
    >
      <header className="card-head" onDoubleClick={props.onToggleExpand}>
        <div className="card-titles">
          <div className="card-project">
            {session.projectName}
            {index < 9 && <kbd className="card-kbd">{index + 1}</kbd>}
          </div>
          <div className="card-title" title={session.title}>
            {session.title}
          </div>
        </div>
        <div className="card-actions">
          <StatusDot status={session.status} />
          {session.status === 'working' && (
            <button className="icon" title="Interromper turno" onClick={props.onInterrupt}>
              ■
            </button>
          )}
          <button
            className="icon"
            title={expanded ? 'Restaurar' : 'Expandir'}
            onClick={props.onToggleExpand}
          >
            {expanded ? '⤡' : '⤢'}
          </button>
          <button className="icon" title="Fechar (vai para o histórico)" onClick={props.onClose}>
            ✕
          </button>
        </div>
      </header>
      <Transcript
        entries={entries}
        permissions={permissions}
        working={session.status === 'working'}
        onPermission={props.onPermission}
      />
      <footer className="card-input">
        <textarea
          ref={props.registerInput}
          value={draft}
          rows={1}
          placeholder={
            !connected
              ? 'Reconectando ao servidor…'
              : session.status === 'waiting'
                ? 'Responda o pedido de permissão acima…'
                : 'Mensagem… (Enter envia, Shift+Enter quebra linha)'
          }
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // não envia no meio de composição IME (acentos, CJK)
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <button
          className="send"
          onClick={submit}
          disabled={!draft.trim() || !connected}
          title="Enviar"
        >
          ➤
        </button>
      </footer>
    </section>
  )
}
