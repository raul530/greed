import { useEffect, useRef, useState } from 'react'
import type { PermissionRequest, SessionMeta, TranscriptEntry } from '../../../shared/types'
import { api } from '../api'
import { shouldInline } from '../attachments'
import { EFFORTS, MODELS, permShort } from '../models'
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
  onSetModel: (model: string | null) => void
  onSetEffort: (effort: string | null) => void
  onSetPermissionMode: (mode: string) => void
  registerInput: (el: HTMLTextAreaElement | null) => void
}

type Attachment =
  | { id: string; name: string; state: 'uploading' }
  | { id: string; name: string; state: 'inline'; content: string }
  | { id: string; name: string; state: 'file'; path: string }
  | { id: string; name: string; state: 'error'; message: string }

function StatusDot({ status }: { status: SessionMeta['status'] }) {
  const label = status === 'working' ? 'trabalhando' : status === 'waiting' ? 'esperando você' : 'idle'
  return <span className={`status-dot ${status}`} title={label} />
}

const newId = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(Math.random())

export function SessionCard(props: Props) {
  const { session, entries, permissions, index, expanded, connected } = props
  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [dragging, setDragging] = useState(false)
  const rootRef = useRef<HTMLElement | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)

  const uploading = attachments.some((a) => a.state === 'uploading')
  const ready = attachments.filter((a) => a.state === 'inline' || a.state === 'file')

  const addFiles = async (files: File[]) => {
    for (const file of files) {
      const id = newId()
      if (shouldInline(file)) {
        try {
          const content = await file.text()
          setAttachments((prev) => [...prev, { id, name: file.name, state: 'inline', content }])
          // além do inline no contexto, persiste + indexa na base de conhecimento do projeto
          void api.uploadAttachment(session.id, file).catch(() => {})
        } catch {
          setAttachments((prev) => [
            ...prev,
            { id, name: file.name, state: 'error', message: 'falha ao ler' },
          ])
        }
      } else {
        setAttachments((prev) => [...prev, { id, name: file.name, state: 'uploading' }])
        try {
          const { path } = await api.uploadAttachment(session.id, file)
          setAttachments((prev) =>
            prev.map((a) => (a.id === id ? { id, name: file.name, state: 'file', path } : a)),
          )
        } catch (err) {
          setAttachments((prev) =>
            prev.map((a) =>
              a.id === id
                ? { id, name: file.name, state: 'error', message: err instanceof Error ? err.message : 'falha' }
                : a,
            ),
          )
        }
      }
    }
  }

  const removeAttachment = (id: string) =>
    setAttachments((prev) => prev.filter((a) => a.id !== id))

  const submit = () => {
    const text = draft.trim()
    if ((!text && ready.length === 0) || !connected || uploading) return
    let composed = text
    for (const a of ready) {
      if (a.state === 'inline') {
        composed += `${composed ? '\n\n' : ''}----- arquivo anexado: ${a.name} -----\n${a.content}\n----- fim: ${a.name} -----`
      } else if (a.state === 'file') {
        composed += `${composed ? '\n\n' : ''}[arquivo anexado salvo em ./${a.path} — abra com Read/Edit]`
      }
    }
    if (props.onSend(composed)) {
      setDraft('')
      setAttachments([])
    }
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
    dragging ? 'dragging' : '',
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
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          setDragging(true)
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false)
      }}
      onDrop={(e) => {
        if (e.dataTransfer.files.length > 0) {
          e.preventDefault()
          setDragging(false)
          void addFiles([...e.dataTransfer.files])
        }
      }}
    >
      <header className="card-head" onDoubleClick={props.onToggleExpand}>
        <div className="card-titles">
          <div className="card-project">
            {session.projectName}
            {index < 9 && <kbd className="card-kbd">{index + 1}</kbd>}
            {session.codebasePath && (
              <span className="codebase-badge" title={session.codebasePath}>
                ▸ {session.codebasePath.split('/').filter(Boolean).pop()}
              </span>
            )}
          </div>
          <div className="card-title" title={session.title}>
            {session.title}
          </div>
        </div>
        <div className="card-actions">
          <select
            className="model-select"
            value={session.model ?? ''}
            title="Modelo desta sessão (vale a partir do próximo turno)"
            onChange={(e) => props.onSetModel(e.target.value || null)}
          >
            {MODELS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
          <select
            className="model-select effort-select"
            value={session.effort ?? ''}
            title="Esforço de raciocínio (mais = mais consumo; vale no próximo turno)"
            onChange={(e) => props.onSetEffort(e.target.value || null)}
          >
            {EFFORTS.map((x) => (
              <option key={x.value} value={x.value}>
                {x.value ? `⚡ ${x.label}` : 'Esforço'}
              </option>
            ))}
          </select>
          <button
            className={`perm-toggle ${session.permissionMode}`}
            title={
              session.permissionMode === 'bypassPermissions'
                ? 'Autônomo: roda tools sem pedir. Clique para voltar a perguntar.'
                : 'Pede aprovação. Clique para rodar sem perguntar (autônomo).'
            }
            onClick={() =>
              props.onSetPermissionMode(
                session.permissionMode === 'bypassPermissions' ? 'default' : 'bypassPermissions',
              )
            }
          >
            {permShort(session.permissionMode)}
          </button>
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
        {attachments.length > 0 && (
          <div className="attach-chips">
            {attachments.map((a) => (
              <span key={a.id} className={`attach-chip ${a.state}`} title={a.name}>
                <span className="attach-icon">
                  {a.state === 'uploading' ? '⏳' : a.state === 'error' ? '⚠' : '📎'}
                </span>
                <span className="attach-name">{a.name}</span>
                <span className="attach-kind">
                  {a.state === 'inline' ? 'texto' : a.state === 'file' ? 'arquivo' : a.state === 'error' ? a.message : 'enviando…'}
                </span>
                <button className="attach-x" title="Remover" onClick={() => removeAttachment(a.id)}>
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="input-row">
          <button
            className="attach-btn"
            title="Anexar arquivo (.md, texto, código, ou qualquer arquivo)"
            onClick={() => fileRef.current?.click()}
          >
            📎
          </button>
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) void addFiles([...e.target.files])
              e.target.value = ''
            }}
          />
          <textarea
            ref={props.registerInput}
            value={draft}
            rows={1}
            placeholder={
              !connected
                ? 'Reconectando ao servidor…'
                : session.status === 'waiting'
                  ? 'Responda o pedido de permissão acima…'
                  : 'Mensagem… (Enter envia, 📎 ou arraste p/ anexar)'
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
            disabled={(!draft.trim() && ready.length === 0) || !connected || uploading}
            title={uploading ? 'Aguardando anexo…' : 'Enviar'}
          >
            ➤
          </button>
        </div>
      </footer>
    </section>
  )
}
