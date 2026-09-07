import { Gauge } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { SessionUsage } from '../../../shared/types'

/** 950 → "950", 4200 → "4.2k", 142000 → "142k", 1300000 → "1.30M" */
export function fmtTokens(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

function fmtUsd(n: number): string {
  if (n > 0 && n < 0.01) return '< US$ 0,01'
  return `US$ ${n.toFixed(2).replace('.', ',')}`
}

function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}min ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}min`
}

/** janela padrão quando o SDK ainda não disse qual é */
const DEFAULT_WINDOW = 200_000

/**
 * Consumo deste chat: um chip na barra do composer com o total de tokens e a
 * barra de contexto; o clique abre o detalhe. Só existe pra sessões que já
 * rodaram um turno depois da contagem existir.
 */
export function UsageChip({ usage }: { usage: SessionUsage | null | undefined }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const total = usage ? usage.input + usage.output + usage.cacheRead + usage.cacheWrite : 0
  const window_ = usage?.contextWindow || DEFAULT_WINDOW
  const ctxPct = usage ? Math.min(100, Math.round((usage.context / window_) * 100)) : 0
  // janela quase cheia: próximo passo é compactação, ou abrir outro chat
  const hot = ctxPct >= 75

  const tip = !usage
    ? 'Consumo deste chat: começa a contar no próximo turno'
    : `${fmtTokens(total)} tokens neste chat · contexto ${ctxPct}% · clique pro detalhe`

  return (
    <div className="usage-wrap" ref={ref}>
      <button
        className={['usage-chip', open ? 'on' : '', hot ? 'hot' : ''].filter(Boolean).join(' ')}
        data-tip={tip}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Gauge size={12} />
        <span className="usage-num">{usage ? fmtTokens(total) : '—'}</span>
        {usage && usage.context > 0 && (
          <span className="usage-ctx" aria-hidden="true">
            <i style={{ width: `${ctxPct}%` }} />
          </span>
        )}
      </button>
      {open && (
        <div className="usage-pop" role="dialog" aria-label="Consumo deste chat">
          <div className="usage-pop-head">Consumo deste chat</div>
          {!usage ? (
            <p className="usage-pop-empty">
              Nada contado ainda. A contagem começa no próximo turno deste chat.
            </p>
          ) : (
            <>
              <div className="usage-ctxrow">
                <span>contexto em uso</span>
                <b>
                  {fmtTokens(usage.context)} / {fmtTokens(window_)}
                </b>
              </div>
              <div className={`usage-bar ${hot ? 'hot' : ''}`} aria-hidden="true">
                <i style={{ width: `${ctxPct}%` }} />
              </div>
              <dl className="usage-grid">
                <dt>entrada</dt>
                <dd>{fmtTokens(usage.input)}</dd>
                <dt>saída</dt>
                <dd>{fmtTokens(usage.output)}</dd>
                <dt>cache lido</dt>
                <dd>{fmtTokens(usage.cacheRead)}</dd>
                <dt>cache escrito</dt>
                <dd>{fmtTokens(usage.cacheWrite)}</dd>
                <dt>turnos</dt>
                <dd>{usage.turns}</dd>
                <dt>tempo de modelo</dt>
                <dd>{fmtDur(usage.durationMs)}</dd>
                <dt>custo estimado</dt>
                <dd>{fmtUsd(usage.costUsd)}</dd>
              </dl>
              <div className="usage-pop-foot">
                desde {new Date(usage.since).toLocaleDateString('pt-BR')} · estimativa local, não
                é fatura
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
