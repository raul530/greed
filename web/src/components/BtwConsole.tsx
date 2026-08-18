import { useEffect, useRef, useState } from 'react'
import type { BtwExchange } from '../../../shared/types'
import { Markdown } from './Markdown'

interface Props {
  /** de qual card veio a pergunta */
  title: string
  exchanges: BtwExchange[]
  onAsk: (text: string) => void
  onClose: () => void
}

/**
 * Console lateral do /btw: fica flutuando num canto, fora do grid, e não rouba
 * espaço de card nenhum. O turno principal continua rodando enquanto isso.
 */
export function BtwConsole({ title, exchanges, onAsk, onClose }: Props) {
  const [draft, setDraft] = useState('')
  const [min, setMin] = useState(false)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [exchanges])

  useEffect(() => {
    if (!min) inputRef.current?.focus()
  }, [min])

  const send = () => {
    const text = draft.trim()
    if (!text) return
    onAsk(text)
    setDraft('')
  }

  const waiting = exchanges.some((e) => e.status === 'asking')

  return (
    <aside className={`btw ${min ? 'min' : ''}`}>
      <header className="btw-head">
        <span className="btw-mark">/btw</span>
        <span className="btw-title" data-tip={`Pergunta de canto — ${title}`}>
          {title}
        </span>
        {waiting && <span className="btw-dot" data-tip="Pensando na resposta…" />}
        <button
          className="icon"
          data-tip={min ? 'Abrir o console' : 'Encolher para a barra'}
          onClick={() => setMin((v) => !v)}
        >
          {min ? '▴' : '▾'}
        </button>
        <button className="icon" data-tip="Fechar — as perguntas ficam salvas" onClick={onClose}>
          ✕
        </button>
      </header>
      {!min && (
        <>
          <div className="btw-body" ref={bodyRef}>
            {exchanges.length === 0 && (
              <div className="btw-empty">
                Pergunta rápida sem atrapalhar o turno. Ele só lê o repositório — não edita nada.
              </div>
            )}
            {exchanges.map((e) => (
              <div className="btw-pair" key={e.id}>
                <div className="btw-q">{e.question}</div>
                <div className={`btw-a ${e.status}`}>
                  {e.status === 'asking' ? (
                    <span className="btw-thinking">pensando…</span>
                  ) : (
                    <Markdown text={e.answer} />
                  )}
                </div>
              </div>
            ))}
          </div>
          <div className="btw-input">
            <textarea
              ref={inputRef}
              rows={2}
              value={draft}
              placeholder="Outra pergunta de canto…"
              onChange={(ev) => setDraft(ev.target.value)}
              onKeyDown={(ev) => {
                if (ev.key === 'Enter' && !ev.shiftKey && !ev.nativeEvent.isComposing) {
                  ev.preventDefault()
                  send()
                }
                if (ev.key === 'Escape') onClose()
              }}
            />
            <button className="send" data-tip="Perguntar (Enter)" onClick={send} disabled={!draft.trim()}>
              ➤
            </button>
          </div>
        </>
      )}
    </aside>
  )
}
