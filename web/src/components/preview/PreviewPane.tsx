import { useEffect, useState } from 'react'
import { Markdown } from '../Markdown'
import { previewUrl, type PreviewFile } from './usePreview'

interface Props {
  sessionId: string
  title: string
  files: PreviewFile[]
  nonce: number
  onReload: () => void
  onClose: () => void
}

const WIDTHS = [
  { label: 'auto', value: 0, tip: 'Largura total do palco' },
  { label: '375', value: 375, tip: 'Celular — 375px' },
  { label: '768', value: 768, tip: 'Tablet — 768px' },
  { label: '1280', value: 1280, tip: 'Desktop — 1280px' },
]

type Kind = 'page' | 'markdown' | 'text'

function kindOf(rel: string): Kind {
  const ext = rel.split('.').pop()?.toLowerCase() ?? ''
  if (ext === 'html' || ext === 'htm' || ext === 'svg' || ext === 'pdf') return 'page'
  if (ext === 'md' || ext === 'markdown') return 'markdown'
  return 'text'
}

/** Modal grande (16:9) pra testar o html de verdade, ler um .md e baixar o arquivo. */
export function PreviewPane({ sessionId, title, files, nonce, onReload, onClose }: Props) {
  const [rel, setRel] = useState(files[0]?.rel ?? '')
  const [width, setWidth] = useState(0)
  const [text, setText] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // arquivo escolhido sumiu (renomeado pelo agente): volta pro mais recente
  const current = files.some((f) => f.rel === rel) ? rel : (files[0]?.rel ?? '')
  const url = current ? previewUrl(sessionId, current, nonce) : ''
  const kind = current ? kindOf(current) : 'page'

  // markdown e texto a gente mesmo renderiza; html vai pro iframe
  useEffect(() => {
    if (!url || kind === 'page') {
      setText(null)
      return
    }
    let alive = true
    setText(null)
    void fetch(url)
      .then((r) => r.text())
      .then((t) => alive && setText(t))
      .catch(() => alive && setText('(não deu pra ler o arquivo)'))
    return () => {
      alive = false
    }
  }, [url, kind])

  const fileName = current.split('/').pop() ?? current

  return (
    <div
      className="overlay prev-overlay"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="prev-modal">
        <div className="prev-head">
          <span className="prev-src" data-tip={`Sessão: ${title}`}>
            ▣ preview
          </span>
          {files.length > 1 ? (
            <select
              className="prev-file"
              value={current}
              onChange={(e) => setRel(e.target.value)}
              data-tip="Qual arquivo abrir (mais recente primeiro)"
            >
              {files.map((f) => (
                <option key={f.rel} value={f.rel}>
                  {f.rel}
                </option>
              ))}
            </select>
          ) : (
            <span className="prev-file-name" data-tip={current}>
              {current}
            </span>
          )}
          <div className="prev-tools">
            {kind === 'page' && (
              <div className="prev-widths">
                {WIDTHS.map((w) => (
                  <button
                    key={w.label}
                    className={`prev-w ${width === w.value ? 'on' : ''}`}
                    onClick={() => setWidth(w.value)}
                    data-tip={w.tip}
                  >
                    {w.label}
                  </button>
                ))}
              </div>
            )}
            <a
              className="prev-download"
              href={url ? `${url}&download=1` : undefined}
              download={fileName}
              data-tip={`Salvar ${fileName} no seu computador`}
            >
              ⤓ baixar
            </a>
            <button className="icon" data-tip="Recarregar do disco" onClick={onReload}>
              ↻
            </button>
            <a
              className="icon"
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              data-tip="Abrir numa aba do navegador"
            >
              ↗
            </a>
            <button className="icon prev-close" data-tip="Fechar (esc)" onClick={onClose}>
              ✕
            </button>
          </div>
        </div>
        <div className={`prev-stage ${kind !== 'page' ? 'doc' : ''}`}>
          {!url ? (
            <div className="act-empty">Nenhum arquivo pra mostrar nesta sessão ainda.</div>
          ) : kind === 'page' ? (
            <iframe
              key={url}
              className="prev-frame"
              style={width ? { width: `${width}px`, flex: 'none' } : undefined}
              src={url}
              title={current}
              sandbox="allow-scripts allow-forms allow-popups"
            />
          ) : text === null ? (
            <div className="act-empty">lendo…</div>
          ) : kind === 'markdown' ? (
            <div className="prev-doc md-doc">
              <Markdown text={text} />
            </div>
          ) : (
            <pre className="prev-doc prev-raw">{text}</pre>
          )}
        </div>
      </div>
    </div>
  )
}
