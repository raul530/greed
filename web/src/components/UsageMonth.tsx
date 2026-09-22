import { useEffect, useState } from 'react'
import type { MonthReport } from '../../../shared/types'
import { api } from '../api'
import { fmtTokens } from './UsageChip'

/** um livro de ~300 páginas tem umas 100 mil palavras, perto de 130 mil tokens */
const BOOK_TOKENS = 130_000

const dayLabel = (day: number) =>
  new Date(day).toLocaleDateString('pt-BR', { day: 'numeric', month: 'short' })

function books(output: number): string {
  const n = Math.round(output / BOOK_TOKENS)
  if (n < 1) return 'menos de um livro, por enquanto'
  return `≈ ${n.toLocaleString('pt-BR')} livro${n > 1 ? 's' : ''} de 300 páginas`
}

/**
 * Os últimos 30 dias em números grandes. É pra ostentar, não pra decidir: vem
 * dos mesmos transcripts locais dos insights, então conta só esta máquina.
 */
export function UsageMonth() {
  const [report, setReport] = useState<MonthReport | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    api
      .month()
      .then((r) => {
        if (alive) setReport(r)
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      alive = false
    }
  }, [])

  return (
    <section className="usage-panel month">
      <header className="usage-head">
        <h2>Últimos 30 dias</h2>
        <span className="usage-when">só desta máquina</span>
      </header>
      {error && <p className="usage-error">⚠ {error}</p>}
      {report ? (
        report.calls > 0 ? (
          <MonthNumbers report={report} />
        ) : (
          <p className="usage-hint">Nenhuma chamada nos últimos 30 dias.</p>
        )
      ) : (
        !error && <p className="usage-hint">Somando 30 dias de transcripts…</p>
      )}
    </section>
  )
}

function MonthNumbers({ report }: { report: MonthReport }) {
  const peak = report.days.reduce((a, b) => (b.tokens > a.tokens ? b : a))
  const today = report.days[report.days.length - 1]
  return (
    <>
      <div className="month-tiles">
        <div className="month-tile">
          <i>tokens</i>
          <b>{fmtTokens(report.tokens)}</b>
          <small>contando leitura de cache</small>
        </div>
        <div className="month-tile">
          <i>escritos pelo modelo</i>
          <b>{fmtTokens(report.output)}</b>
          <small>{books(report.output)}</small>
        </div>
        <div className="month-tile">
          <i>chamadas</i>
          <b>{report.calls.toLocaleString('pt-BR')}</b>
          <small>
            em {report.chats} chat{report.chats > 1 ? 's' : ''}
          </small>
        </div>
        <div className="month-tile">
          <i>maior dia</i>
          <b>{fmtTokens(peak.tokens)}</b>
          <small>{dayLabel(peak.day)}</small>
        </div>
      </div>
      {/* um traço por dia; hoje (ainda pela metade) vai na cor de destaque */}
      <div className="month-days" role="img" aria-label="Tokens por dia nos últimos 30 dias">
        {report.days.map((d) => (
          <span
            key={d.day}
            className={`month-day ${d === today ? 'today' : ''}`}
            data-tip={`${dayLabel(d.day)} · ${fmtTokens(d.tokens)} tokens`}
          >
            <i style={{ height: `${(d.tokens / peak.tokens) * 100}%` }} />
          </span>
        ))}
      </div>
    </>
  )
}
