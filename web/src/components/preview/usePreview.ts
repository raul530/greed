import { useEffect, useRef, useState } from 'react'
import { api } from '../../api'
import type { SessionMeta } from '../../../../shared/types'

export interface PreviewFile {
  rel: string
  mtime: number
  /** qual pasta da sessão (codebase ou projeto) tem esse arquivo */
  root: number
  /** saiu do último turno que produziu alguma coisa */
  last: boolean
}

const hideKey = (sessionId: string) => `greed:previewHidden:${sessionId}`

function loadHidden(sessionId: string): number {
  try {
    return Number(localStorage.getItem(hideKey(sessionId)) ?? 0)
  } catch {
    return 0
  }
}

/** Lista os HTML da pasta da sessão. Só relê quando um turno termina — sem polling. */
export function usePreview(sessionId: string, status: SessionMeta['status']) {
  const [files, setFiles] = useState<PreviewFile[]>([])
  const [nonce, setNonce] = useState(0)
  /** dispensado até aqui: some da barra, e volta quando um arquivo for mexido depois disso */
  const [hiddenUntil, setHiddenUntil] = useState(() => loadHidden(sessionId))
  const wasWorking = useRef(false)

  const load = () => {
    let alive = true
    void api
      .previewFiles(sessionId)
      .then((r) => {
        if (!alive) return
        setFiles(r.files)
        setNonce((n) => n + 1) // cache-bust do iframe: o arquivo pode ter mudado
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }

  // no mount, e de novo sempre que ele para de trabalhar (aí o arquivo já existe)
  useEffect(() => {
    const ended = wasWorking.current && status !== 'working'
    wasWorking.current = status === 'working'
    if (ended) return load()
    return undefined
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => load(), [sessionId])

  const newest = files.length > 0 ? Math.max(...files.map((f) => f.mtime)) : 0
  const hidden = newest > 0 && newest <= hiddenUntil

  const hide = () => {
    setHiddenUntil(newest)
    try {
      localStorage.setItem(hideKey(sessionId), String(newest))
    } catch {
      // sem localStorage o trilho só volta no próximo reload
    }
  }

  return { files, nonce, hidden, hide, reload: load }
}

export const previewUrl = (sessionId: string, file: PreviewFile, nonce: number) =>
  `/preview/${encodeURIComponent(sessionId)}/${file.rel.split('/').map(encodeURIComponent).join('/')}?v=${nonce}&root=${file.root ?? 0}`

/** chave estável de um arquivo: o mesmo rel pode existir nas duas pastas */
export const fileKey = (f: PreviewFile) => `${f.root ?? 0}:${f.rel}`
