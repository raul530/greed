import { Brain, Check, Clock, Paperclip, Wrench, X } from 'lucide-react'
import { memo, useEffect, useRef, useState } from 'react'
import type { TranscriptEntry } from '../../../shared/types'
import { Markdown } from './Markdown'

const Entry = memo(function Entry({ entry }: { entry: TranscriptEntry }) {
  switch (entry.kind) {
    case 'user':
      return (
        <div className="msg-user">
          {entry.text}
          {entry.attachments && entry.attachments.length > 0 && (
            <div className="msg-files">
              {entry.attachments.map((a) => (
                <span
                  key={a.name}
                  className="msg-file"
                  data-tip={
                    a.kind === 'inline'
                      ? 'Conteúdo foi junto no prompt (não ocupa a tela)'
                      : 'Salvo na pasta do projeto — ele abre com Read'
                  }
                >
                  <Paperclip size={10} />
                  {a.name}
                </span>
              ))}
            </div>
          )}
        </div>
      )
    case 'assistant':
      return (
        <div className="msg-assistant">
          <Markdown text={entry.text} />
          {entry.streaming && <span className="caret" />}
        </div>
      )
    case 'tool': {
      const st = entry.status ?? 'done'
      return (
        <div className="tool-line" data-st={st} title={entry.result || entry.summary}>
          <span className="tool-mark">
            {st === 'running' ? (
              <span className="act-spin" />
            ) : st === 'error' ? (
              <X size={10} />
            ) : (
              <Check size={10} />
            )}
          </span>
          <span className="tool-name">
            <Wrench size={10} />
            {entry.name}
          </span>
          <span className="tool-sum">{entry.result || entry.summary}</span>
        </div>
      )
    }
    case 'permission': {
      const Mark = entry.decision === 'allow' ? Check : entry.decision === 'deny' ? X : Clock
      const label =
        entry.decision === 'allow'
          ? 'permitido'
          : entry.decision === 'deny'
            ? 'negado'
            : 'aguardando decisão'
      return (
        <div className={`perm-line ${entry.decision ?? 'pending'}`} title={entry.summary}>
          <Mark size={11} />
          {label} — {entry.toolName}
        </div>
      )
    }
    case 'question': {
      if (!entry.answers) {
        return (
          <div className="perm-line pending" title={entry.questions[0]?.question}>
            ⏳ aguardando sua resposta
          </div>
        )
      }
      return (
        <div className="ask-line">
          {entry.questions.map((q) => (
            <div key={q.question}>
              <span className="ask-line-q">{q.question}</span>
              <span className="ask-line-a">{entry.answers?.[q.question] ?? '—'}</span>
            </div>
          ))}
        </div>
      )
    }
    case 'info':
      return <div className="info-line">{entry.text}</div>
    case 'memory':
      return (
        <div className="memory-line" data-src={entry.source}>
          <span className="memory-mark">
            <Brain size={12} />
          </span>
          <span>memória atualizada</span>
          <span className="memory-what">{entry.text}</span>
        </div>
      )
    case 'error':
      return <div className="error-line">{entry.text}</div>
    default:
      return null
  }
})

interface Props {
  entries: TranscriptEntry[]
  /** há pedido de permissão aberto — o painel dele vive no PermissionDock */
  pending: boolean
  working: boolean
}

/**
 * Quantas entradas o card desenha de cara. Chat longo tem milhares, e desenhar
 * todas deixa cada token e cada tecla lentos; o resto vem pelo botão.
 */
const PAGE = 200

export const Transcript = memo(function Transcript({ entries, pending, working }: Props) {
  const ref = useRef<HTMLDivElement | null>(null)
  const stick = useRef(true)
  // o começo da janela fica parado: entrada nova entra embaixo e nada some de
  // cima enquanto você lê. null = ainda sem transcript (card reaberto antes de
  // ele chegar), aí o corte é feito quando chegar
  const [from, setFrom] = useState<number | null>(() => startOf(entries))
  if (from === null && entries.length > 0) setFrom(startOf(entries))
  const start = Math.min(from ?? 0, startOf(entries) ?? 0)

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
      {start > 0 && (
        <button className="transcript-more" onClick={() => setFrom(Math.max(0, start - PAGE))}>
          mostrar anteriores ({start} ocultas)
        </button>
      )}
      {entries.slice(start).map((e) => (
        <Entry key={e.id} entry={e} />
      ))}
      {working && !pending && (
        <div className="thinking" aria-label="trabalhando">
          <span />
          <span />
          <span />
        </div>
      )}
    </div>
  )
})

function startOf(entries: TranscriptEntry[]): number | null {
  return entries.length > 0 ? Math.max(0, entries.length - PAGE) : null
}
