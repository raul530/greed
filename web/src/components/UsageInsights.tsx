import { useCallback, useEffect, useState } from 'react'
import type { InsightsReport, UsageRow } from '../../../shared/types'
import { api } from '../api'

/**
 * De onde saiu o consumo. Vem dos transcripts locais do Claude Code, não do
 * endpoint de limites: lá só tem percentual, aqui tem token de verdade.
 */
export function UsageInsights() {
  const [report, setReport] = useState<InsightsReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [hours, setHours] = useState(24)

  const load = useCallback((h: number) => {
    setBusy(true)
    api
      .insights(h)
      .then((r) => {
        setReport(r)
        setError(null)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
  }, [])

  useEffect(() => load(hours), [load, hours])

  return (
    <section className="usage-panel insights">
      <header className="usage-head">
        <h2>Insights · o que consumiu</h2>
        <div className="usage-head-right">
          <div className="range-pick">
            {[24, 168].map((h) => (
              <button key={h} className={hours === h ? 'active' : ''} onClick={() => setHours(h)}>
                {h === 24 ? '24 h' : '7 d'}
              </button>
            ))}
          </div>
          <button onClick={() => load(hours)} disabled={busy}>
            {busy ? 'lendo…' : 'Recarregar'}
          </button>
        </div>
      </header>

      {error && <p className="usage-error">⚠ {error}</p>}

      {!report ? (
        <p className="usage-hint">{busy ? 'Lendo os transcripts locais…' : 'Sem leitura.'}</p>
      ) : report.calls === 0 ? (
        <p className="usage-hint">Nenhuma chamada registrada nessa janela.</p>
      ) : (
        <>
          <p className="insights-src">
            Aproximado, só das sessões desta máquina. Não inclui claude.ai nem outro dispositivo.
            <br />
            {report.calls.toLocaleString('pt-BR')} chamadas · {fmt(report.tokens)} tokens contando
            leitura de cache
          </p>

          <ul className="characteristics">
            {report.characteristics.map((c) => (
              <li key={c.label}>
                <b>{c.label}</b>
                <span>{c.hint}</span>
              </li>
            ))}
          </ul>

          <RankTable title="Por chat" rows={report.byChat} />
          <RankTable title="Por pasta" rows={report.byProject} />
          <RankTable title="Por modelo" rows={report.byModel} />

          <p className="detail-note">
            A fatia pesa cada token pelo custo relativo: saída ~5x a entrada, escrita de cache
            ~1,25x, leitura de cache ~0,1x. Serve pra ordenar quem pesa, não pra estimar preço.
          </p>
        </>
      )}
    </section>
  )
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

function RankTable({ title, rows }: { title: string; rows: UsageRow[] }) {
  if (rows.length === 0) return null
  return (
    <div className="rank">
      <div className="rank-head">
        <span>{title}</span>
        <span>fatia</span>
      </div>
      <ul>
        {rows.map((r) => (
          <li key={r.label}>
            <span className="rank-label" title={r.label}>
              {r.label}
            </span>
            {/* a barra é o próprio fundo da linha: lê a proporção sem precisar de gráfico */}
            <span className="rank-bar" style={{ width: `${r.share}%` }} aria-hidden="true" />
            <span className="rank-tokens">{fmt(r.tokens)}</span>
            <b className="rank-share">{r.share}%</b>
          </li>
        ))}
      </ul>
    </div>
  )
}
