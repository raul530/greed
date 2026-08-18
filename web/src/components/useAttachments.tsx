import { useState } from 'react'
import type { MsgAttachment } from '../../../shared/types'
import { shouldInline } from '../attachments'

export type Attachment =
  | { id: string; name: string; state: 'uploading' }
  | { id: string; name: string; state: 'inline'; content: string }
  | { id: string; name: string; state: 'file'; path: string }
  | { id: string; name: string; state: 'error'; message: string }

/** sobe o arquivo e devolve o caminho absoluto onde ele ficou salvo */
export type Upload = (file: File) => Promise<{ abs: string }>

const newId = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(Math.random())

/** Anexos de um composer: texto pequeno vai inline, o resto é salvo na pasta do projeto. */
export function useAttachments(upload: Upload) {
  const [attachments, setAttachments] = useState<Attachment[]>([])

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
          void upload(file).catch(() => {})
        } catch {
          setAttachments((prev) => [
            ...prev,
            { id, name: file.name, state: 'error', message: 'falha ao ler' },
          ])
        }
      } else {
        setAttachments((prev) => [...prev, { id, name: file.name, state: 'uploading' }])
        try {
          const { abs } = await upload(file)
          setAttachments((prev) =>
            prev.map((a) => (a.id === id ? { id, name: file.name, state: 'file', path: abs } : a)),
          )
        } catch (err) {
          setAttachments((prev) =>
            prev.map((a) =>
              a.id === id
                ? {
                    id,
                    name: file.name,
                    state: 'error',
                    message: err instanceof Error ? err.message : 'falha',
                  }
                : a,
            ),
          )
        }
      }
    }
  }

  /** anexos prontos no formato do protocolo: vão pro modelo, não pro balão */
  const payload = (): MsgAttachment[] =>
    ready.map((a) =>
      a.state === 'inline'
        ? { name: a.name, content: a.content }
        : { name: a.name, path: (a as { path: string }).path },
    )

  return {
    attachments,
    uploading,
    ready,
    addFiles,
    payload,
    remove: (id: string) => setAttachments((prev) => prev.filter((a) => a.id !== id)),
    clear: () => setAttachments([]),
  }
}

export function AttachChips({
  attachments,
  onRemove,
}: {
  attachments: Attachment[]
  onRemove: (id: string) => void
}) {
  if (attachments.length === 0) return null
  return (
    <div className="attach-chips">
      {attachments.map((a) => (
        <span key={a.id} className={`attach-chip ${a.state}`} title={a.name}>
          <span className="attach-icon">
            {a.state === 'uploading' ? '⏳' : a.state === 'error' ? '⚠' : '📎'}
          </span>
          <span className="attach-name">{a.name}</span>
          <span className="attach-kind">
            {a.state === 'inline'
              ? 'texto'
              : a.state === 'file'
                ? 'arquivo'
                : a.state === 'error'
                  ? a.message
                  : 'enviando…'}
          </span>
          <button className="attach-x" data-tip="Tirar este anexo" onClick={() => onRemove(a.id)}>
            ✕
          </button>
        </span>
      ))}
    </div>
  )
}
