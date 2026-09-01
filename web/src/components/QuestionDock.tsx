import { useState } from 'react'
import type { AskQuestion, PermissionRequest } from '../../../shared/types'

interface Props {
  request: PermissionRequest
  queued: number
  onAnswer: (requestId: string, answers: Record<string, string>) => void
}

function questionsOf(request: PermissionRequest): AskQuestion[] {
  const input = request.input as { questions?: AskQuestion[] } | null
  return input?.questions ?? []
}

export function QuestionDock({ request, queued, onAnswer }: Props) {
  const questions = questionsOf(request)
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const [other, setOther] = useState<Record<string, string>>({})

  const toggle = (q: AskQuestion, label: string) => {
    setPicked((prev) => {
      const cur = prev[q.question] ?? []
      if (!q.multiSelect) return { ...prev, [q.question]: [label] }
      return {
        ...prev,
        [q.question]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label],
      }
    })
  }

  const answerFor = (q: AskQuestion): string => {
    const free = (other[q.question] ?? '').trim()
    if (free) return free
    return (picked[q.question] ?? []).join(', ')
  }

  const ready = questions.length > 0 && questions.every((q) => answerFor(q))

  const submit = () => {
    if (!ready) return
    const answers: Record<string, string> = {}
    for (const q of questions) answers[q.question] = answerFor(q)
    onAnswer(request.id, answers)
  }

  return (
    <div className="perm-dock">
      <div className="ask-panel">
        <div className="ask-head">
          <span className="ask-mark">❓</span> Pergunta do agente
          {queued > 0 && <span className="perm-queue">+{queued} na fila</span>}
        </div>
        <div className="ask-body">
          {questions.map((q) => (
            <div className="ask-q" key={q.question}>
              <div className="ask-title">
                {q.header && <span className="ask-tag">{q.header}</span>}
                {q.question}
              </div>
              <div className="ask-options">
                {q.options.map((o) => {
                  const on = (picked[q.question] ?? []).includes(o.label)
                  return (
                    <button
                      key={o.label}
                      className={`ask-option${on ? ' on' : ''}`}
                      title={o.description}
                      onClick={() => toggle(q, o.label)}
                    >
                      <b>{o.label}</b>
                      {o.description && <i>{o.description}</i>}
                    </button>
                  )
                })}
              </div>
              <input
                className="ask-other"
                placeholder="ou escreva outra resposta…"
                value={other[q.question] ?? ''}
                onChange={(e) => setOther((p) => ({ ...p, [q.question]: e.target.value }))}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Enter') submit()
                }}
              />
            </div>
          ))}
        </div>
        <div className="perm-actions">
          <button className="allow" disabled={!ready} onClick={submit}>
            Responder
          </button>
        </div>
      </div>
    </div>
  )
}
