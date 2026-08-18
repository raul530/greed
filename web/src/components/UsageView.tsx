import { useEffect, useMemo, useState } from 'react'
import type { UsageLimit, UsageSample, UsageSnapshot } from '../../../shared/types'
import { api } from '../api'
import { UsageInsights } from './UsageInsights'

interface Props {
  usage: UsageSnapshot | null
  error: string | null
}

/** quantos blocos o medidor tem — cada bloco vale 2,5% */
const SEGMENTS = 40
/** janelas do gráfico; a de 6 h cobre a janela de 5 h, que é a que aperta primeiro */
const RANGES = [
  { id: '1h', label: '1 h', ms: 60 * 60 * 1000 },
  { id: '6h', label: '6 h', ms: 6 * 60 * 60 * 1000 },
  { id: '24h', label: '24 h', ms: 24 * 60 * 60 * 1000 },
] as const
type RangeId = (typeof RANGES)[number]['id']
/** cor + traço: só a cor não separa as linhas dentro de um tema monocromático */
const LINES = [
  { color: 'var(--primary)', dash: '' },
  { color: 'var(--glow)', dash: '7 4' },
  { color: 'var(--text)', dash: '2 3' },
  { color: 'var(--muted)', dash: '10 3 2 3' },
]

/** faixa de perigo — o medidor muda de cor antes de você bater no teto */
function level(percent: number): 'ok' | 'warn' | 'crit' {
  if (percent >= 90) return 'crit'
  if (percent >= 70) return 'warn'
  return 'ok'
}

/** "4 h 42 min" / "3 d 5 h" / "reiniciando" quando a janela já virou */
function untilReset(resetsAt: number | null, now: number): string {
  if (resetsAt == null) return 'sem janela'
  const diff = resetsAt - now
  if (diff <= 0) return 'reiniciando'
  const min = Math.floor(diff / 60_000)
  const h = Math.floor(min / 60)
  const d = Math.floor(h / 24)
  if (d > 0) return `${d} d ${h % 24} h`
  if (h > 0) return `${h} h ${min % 60} min`
  return `${min} min`
}

function ago(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 60) return `há ${s}s`
  return `há ${Math.floor(s / 60)}min`
}

/** janela do resumo de variação */
const TREND_MS = 30 * 60 * 1000

interface Trend {
  delta: number
  /** quanto tempo o delta realmente cobre (pode ser menos que 30 min) */
  spanMs: number
  /** false = ainda não temos 30 min de histórico; o rótulo mostra o span real */
  full: boolean
}

/** Quanto esse limite andou nos últimos 30 min. null quando não dá pra dizer. */
function trendOf(samples: UsageSample[], id: string, now: number): Trend | null {
  const rows = samples.filter((s) => s.values[id] != null)
  if (rows.length < 2) return null // uma leitura só não é variação
  const last = rows[rows.length - 1]
  const start = now - TREND_MS
  // a última leitura antes da janela é a base; sem ela, a mais antiga que temos
  const anchor = [...rows].reverse().find((s) => s.ts <= start)
  const base = anchor ?? rows[0]
  const spanMs = last.ts - base.ts
  if (spanMs <= 0) return null
  return { delta: last.values[id] - base.values[id], spanMs, full: Boolean(anchor) }
}

function spanLabel(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000))
  return min >= 60 ? `${Math.round(min / 60)} h` : `${min} min`
}

/** ▲ +4% em 30 min. Cai pro span real quando o histórico é mais curto que isso. */
function TrendChip({ trend, size }: { trend: Trend | null; size: 'big' | 'chip' }) {
  if (!trend) return null
  const dir = trend.delta > 0 ? 'up' : trend.delta < 0 ? 'down' : 'flat'
  const when = trend.full ? '30 min' : spanLabel(trend.spanMs)
  return (
    <span className={`trend ${dir} ${size}`}>
      <i className="trend-arrow" aria-hidden="true">
        {dir === 'up' ? '▲' : dir === 'down' ? '▼' : '='}
      </i>
      {dir === 'flat' ? 'estável' : `${trend.delta > 0 ? '+' : ''}${trend.delta}%`}
      <i className="trend-when">em {when}</i>
    </span>
  )
}

function Gauge({ percent }: { percent: number }) {
  const lit = Math.round((Math.min(100, percent) / 100) * SEGMENTS)
  return (
    <div className={`gauge ${level(percent)}`} role="img" aria-label={`${percent}%`}>
      {Array.from({ length: SEGMENTS }, (_, i) => (
        <span key={i} className={`seg ${i < lit ? 'on' : ''}`} />
      ))}
    </div>
  )
}

function LimitRow({
  limit,
  trend,
  open,
  onToggle,
  now,
}: {
  limit: UsageLimit
  trend: Trend | null
  open: boolean
  onToggle: () => void
  now: number
}) {
  return (
    <li className={`limit ${level(limit.percent)} ${limit.active ? 'active' : ''} ${open ? 'open' : ''}`}>
      <button
        className="limit-body"
        onClick={onToggle}
        aria-pressed={open}
        title="Ver o consumo por hora deste limite"
      >
        <div className="limit-head">
          <span className="limit-label">
            {limit.active && <i className="limit-dot" aria-hidden="true" />}
            {limit.label}
            <i className="limit-caret" aria-hidden="true">
              ▤
            </i>
          </span>
          <span className="limit-head-right">
            {/* o delta fica colado no número: no rodapé ele sumia entre os outros dados */}
            <TrendChip trend={trend} size="chip" />
            <span className="limit-pct">
              {limit.percent}
              <i>%</i>
            </span>
          </span>
        </div>
        <Gauge percent={limit.percent} />
        <div className="limit-foot">
          <span>{100 - Math.min(100, limit.percent)}% livre</span>
          <span>reinicia em {untilReset(limit.resetsAt, now)}</span>
        </div>
      </button>
    </li>
  )
}

const HOUR = 60 * 60 * 1000
/** medidas do gráfico por hora; aqui a escala é uniforme, então texto não distorce */
const CW = 640
const CH = 210
const PAD = { l: 38, r: 12, t: 14, b: 26 }
const PW = CW - PAD.l - PAD.r
const PH = CH - PAD.t - PAD.b

interface Bucket {
  start: number
  /** null = não temos leitura cobrindo essa hora (≠ consumo zero) */
  consumed: number | null
  partial: boolean
}

/** Nível do limite em t: a última leitura até ali (é degrau, não interpola). */
function levelAt(rows: UsageSample[], id: string, t: number): number | null {
  let out: number | null = null
  for (const s of rows) {
    if (s.ts > t) break
    const v = s.values[id]
    if (v != null) out = v
  }
  return out
}

/**
 * Quanto cada hora das últimas 24 h consumiu desse limite.
 *
 * É a diferença de nível dentro da hora, não o nível. Diferença negativa vira
 * zero de propósito: quando a janela reseta o nível despenca, e isso não é
 * consumo negativo, é a janela virando.
 */
function hourlyBuckets(samples: UsageSample[], id: string, now: number): Bucket[] {
  const rows = samples.filter((s) => s.values[id] != null)
  if (rows.length === 0) return []
  const currentHour = Math.floor(now / HOUR) * HOUR
  const out: Bucket[] = []
  for (let i = 23; i >= 0; i--) {
    const start = currentHour - i * HOUR
    const end = Math.min(start + HOUR, now)
    const a = levelAt(rows, id, start)
    const b = levelAt(rows, id, end)
    // sem leitura antes do começo da hora não dá pra saber o que rodou nela
    const consumed = a == null || b == null ? null : Math.max(0, b - a)
    out.push({ start, consumed, partial: i === 0 })
  }
  return out
}

function hourLabel(ts: number): string {
  return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit' }).replace(/\D+$/, '') + 'h'
}

/** Linha tradicional, com eixos: % consumido por hora nas últimas 24 h. */
function HourlyChart({ samples, id, now }: { samples: UsageSample[]; id: string; now: number }) {
  const data = useMemo(() => {
    const buckets = hourlyBuckets(samples, id, now)
    const withData = buckets.filter((b) => b.consumed != null)
    if (withData.length < 2) return null

    const values = withData.map((b) => b.consumed as number)
    const maxV = Math.max(...values)
    const yMax = Math.max(1, Math.ceil(maxV * 1.25))
    const windowStart = buckets[0].start
    const span = 24 * HOUR

    const x = (ts: number) => PAD.l + ((ts - windowStart) / span) * PW
    const y = (v: number) => PAD.t + PH - (v / yMax) * PH

    // ponto no meio da hora: a barra representa o intervalo, não o instante
    const pts = withData.map((b) => ({
      cx: x(b.start + HOUR / 2),
      cy: y(b.consumed as number),
      value: b.consumed as number,
      start: b.start,
      partial: b.partial,
    }))

    const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.cx.toFixed(1)} ${p.cy.toFixed(1)}`).join(' ')
    const area = `${line} L${pts[pts.length - 1].cx.toFixed(1)} ${(PAD.t + PH).toFixed(1)} L${pts[0].cx.toFixed(1)} ${(PAD.t + PH).toFixed(1)} Z`

    const ticks: { x: number; label: string }[] = []
    for (let i = 0; i < 24; i += 4) {
      ticks.push({ x: x(buckets[i].start), label: hourLabel(buckets[i].start) })
    }

    const total = values.reduce((a, b) => a + b, 0)
    return {
      pts,
      line,
      area,
      yMax,
      ticks,
      total,
      peak: maxV,
      hours: withData.length,
      covered: withData.length < 24,
    }
  }, [samples, id, now])

  if (!data) {
    return (
      <p className="usage-hint">
        Precisa de pelo menos duas horas de histórico pra montar esse gráfico. Ele preenche sozinho
        enquanto o Greed roda.
      </p>
    )
  }

  return (
    <div className="hourly">
      <div className="detail-stats">
        <span>
          <i>consumido</i>
          <b>{data.total}%</b>
        </span>
        <span>
          <i>pico numa hora</i>
          <b>{data.peak}%</b>
        </span>
        <span>
          <i>média por hora</i>
          <b>{(data.total / data.hours).toFixed(1)}%</b>
        </span>
        <span>
          <i>horas cobertas</i>
          <b>{data.hours}</b>
        </span>
      </div>

      <svg className="hourly-chart" viewBox={`0 0 ${CW} ${CH}`} role="img">
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line
              x1={PAD.l}
              x2={PAD.l + PW}
              y1={PAD.t + PH - f * PH}
              y2={PAD.t + PH - f * PH}
              className={f === 0 ? 'axis-line' : 'chart-grid'}
            />
            <text x={PAD.l - 6} y={PAD.t + PH - f * PH + 3} className="axis-text end">
              {Math.round(data.yMax * f)}%
            </text>
          </g>
        ))}
        <line x1={PAD.l} x2={PAD.l} y1={PAD.t} y2={PAD.t + PH} className="axis-line" />
        {data.ticks.map((t) => (
          <text key={t.x} x={t.x} y={CH - 8} className="axis-text mid">
            {t.label}
          </text>
        ))}
        <path d={data.area} className="hourly-area" />
        <path d={data.line} className="hourly-line" />
        {data.pts.map((p) => (
          <circle
            key={p.start}
            cx={p.cx}
            cy={p.cy}
            r="2.5"
            className={`hourly-dot ${p.partial ? 'partial' : ''}`}
          >
            <title>{`${hourLabel(p.start)} · ${p.value}%`}</title>
          </circle>
        ))}
      </svg>

      <p className="detail-note">
        % consumido em cada hora{data.covered ? ' · histórico ainda não cobre 24 h' : ''} · o último
        ponto é a hora corrente, ainda incompleta
      </p>
    </div>
  )
}

const W = 600
const H = 160

/**
 * Histórico de utilização.
 *
 * Três coisas que o gráfico precisa acertar pra ser honesto:
 * o tempo é fixo na janela (uma amostra nova anda pra direita em vez de
 * reescalar tudo), a linha é escada (utilização não interpola entre leituras)
 * e ela se estende até agora com o último valor lido.
 */
function History({
  samples,
  limits,
  rangeMs,
  now,
}: {
  samples: UsageSample[]
  limits: UsageLimit[]
  rangeMs: number
  now: number
}) {
  const chart = useMemo(() => {
    const start = now - rangeMs
    const inWindow = samples.filter((s) => s.ts >= start)
    // a última amostra antes da janela ancora a linha na borda esquerda
    const before = [...samples].reverse().find((s) => s.ts < start)
    const rows = before ? [{ ...before, ts: start }, ...inWindow] : inWindow
    if (rows.length === 0) return null

    // escala do eixo Y: 0..100 esconderia um 13→14; sobe só o necessário
    const peak = Math.max(
      ...limits.map((l) => Math.max(...rows.map((r) => r.values[l.id] ?? 0), 0)),
      0,
    )
    const yMax = Math.min(100, Math.max(10, Math.ceil((peak * 1.3) / 10) * 10))

    const x = (ts: number) => ((ts - start) / rangeMs) * W
    const y = (v: number) => H - (Math.min(yMax, v) / yMax) * H

    const lines = limits.map((l) => {
      let d = ''
      let prevY: number | null = null
      for (const r of rows) {
        const v = r.values[l.id]
        if (v == null) continue
        const px = x(r.ts)
        const py = y(v)
        if (prevY == null) d += `M${px.toFixed(1)} ${py.toFixed(1)}`
        else d += ` L${px.toFixed(1)} ${prevY.toFixed(1)} L${px.toFixed(1)} ${py.toFixed(1)}`
        prevY = py
      }
      // segura o último valor até agora — é o que vale enquanto não chega leitura nova
      if (prevY != null) d += ` L${W} ${prevY.toFixed(1)}`
      return { id: l.id, label: l.label, percent: l.percent, d: d || null }
    })

    return { lines: lines.filter((l) => l.d), yMax }
  }, [samples, limits, rangeMs, now])

  if (!chart || chart.lines.length === 0) {
    return (
      <p className="usage-hint">
        Ainda sem leitura nesta janela. As amostras vão se acumulando enquanto o Greed roda.
      </p>
    )
  }

  return (
    <>
      <div className="chart-wrap">
        <svg className="usage-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img">
          {[0.25, 0.5, 0.75].map((f) => (
            <line
              key={f}
              x1="0"
              x2={W}
              y1={H - f * H}
              y2={H - f * H}
              className="chart-grid"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {chart.lines.map((p, i) => {
            const line = LINES[i % LINES.length]
            return (
              <path
                key={p.id}
                d={p.d ?? ''}
                fill="none"
                stroke={line.color}
                strokeDasharray={line.dash || undefined}
                vectorEffect="non-scaling-stroke"
                strokeWidth="1.5"
              />
            )
          })}
        </svg>
        <span className="chart-tick top">{chart.yMax}%</span>
        <span className="chart-tick mid">{chart.yMax / 2}%</span>
        <span className="chart-tick bottom">0%</span>
        <span className="chart-x left">-{RANGES.find((r) => r.ms === rangeMs)?.label}</span>
        <span className="chart-x right">agora</span>
      </div>
      {/* uma por linha: em coluna cabe o valor atual junto, e sobra espaço no painel */}
      <ul className="chart-legend">
        {chart.lines.map((p, i) => {
          const line = LINES[i % LINES.length]
          return (
            <li key={p.id}>
              <svg width="20" height="4" aria-hidden="true">
                <line
                  x1="0"
                  y1="2"
                  x2="20"
                  y2="2"
                  stroke={line.color}
                  strokeWidth="1.5"
                  strokeDasharray={line.dash || undefined}
                />
              </svg>
              <span className="legend-label">{p.label}</span>
              <b className={level(p.percent)}>{p.percent}%</b>
            </li>
          )
        })}
      </ul>
    </>
  )
}

export function UsageView({ usage, error }: Props) {
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState(false)
  const [range, setRange] = useState<RangeId>('6h')
  /** limite com o quadro de detalhe por hora aberto (um por vez) */
  const [openLimit, setOpenLimit] = useState<string | null>(null)
  // limite sumiu da resposta (mudança de plano, etc.): o quadro fecha sozinho
  const detailLimit = usage?.limits.find((l) => l.id === openLimit) ?? null

  // relógio de 1s: os contadores de "reinicia em" andam sozinhos
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const refresh = () => {
    setBusy(true)
    api.refreshUsage().catch(() => {
      // o erro volta pelo WS e aparece na faixa de aviso
    }).finally(() => setBusy(false))
  }

  // o número grande é o pior limite; a variação mostrada é a dele, não de outro
  const peakLimit = usage
    ? usage.limits.reduce<UsageLimit | null>((a, b) => (!a || b.percent > a.percent ? b : a), null)
    : null
  const peak = peakLimit?.percent ?? 0
  // o relógio de 1s não precisa recalcular delta; 15s é resolução de sobra
  const trendClock = Math.floor(now / 15_000) * 15_000
  const trends = useMemo(() => {
    const map = new Map<string, Trend | null>()
    if (usage) for (const l of usage.limits) map.set(l.id, trendOf(usage.history, l.id, trendClock))
    return map
  }, [usage, trendClock])

  return (
    <main className="usage">
      <section className="usage-panel">
        <header className="usage-head">
          <h2>Consumo da assinatura</h2>
          <div className="usage-head-right">
            {usage && <span className="usage-when">lido {ago(usage.fetchedAt, now)}</span>}
            <button onClick={refresh} disabled={busy}>
              {busy ? 'lendo…' : 'Atualizar'}
            </button>
          </div>
        </header>

        {error && <p className="usage-error">⚠ {error}</p>}

        {!usage ? (
          <p className="usage-hint">{error ? 'Sem leitura.' : 'Lendo o consumo…'}</p>
        ) : (
          <>
            <div className="usage-peak">
              <span className={`peak-value ${level(peak)}`}>
                {peak}
                <i>%</i>
              </span>
              <span className="peak-side">
                <span className="peak-label">
                  maior limite em uso
                  {peakLimit ? ` · ${peakLimit.label}` : ''}
                </span>
                <TrendChip
                  trend={peakLimit ? (trends.get(peakLimit.id) ?? null) : null}
                  size="big"
                />
              </span>
            </div>
            <ul className="limits">
              {usage.limits.map((l) => (
                <LimitRow
                  key={l.id}
                  limit={l}
                  trend={trends.get(l.id) ?? null}
                  open={openLimit === l.id}
                  onToggle={() => setOpenLimit(openLimit === l.id ? null : l.id)}
                  now={now}
                />
              ))}
            </ul>
            {usage.extra && (
              <div className="usage-extra">
                <span>Créditos extras</span>
                <b>
                  {usage.extra.usedMinor != null
                    ? `${(usage.extra.usedMinor / 100).toFixed(2)} ${usage.extra.currency ?? ''}`
                    : '—'}
                  {usage.extra.percent != null ? ` · ${Math.round(usage.extra.percent)}%` : ''}
                </b>
              </div>
            )}
          </>
        )}
      </section>

      <section className="usage-panel">
        <header className="usage-head">
          <h2>Histórico</h2>
          <div className="range-pick">
            {RANGES.map((r) => (
              <button
                key={r.id}
                className={range === r.id ? 'active' : ''}
                onClick={() => setRange(r.id)}
              >
                {r.label}
              </button>
            ))}
          </div>
        </header>
        {usage && (
          <History
            samples={usage.history}
            limits={usage.limits}
            rangeMs={RANGES.find((r) => r.id === range)?.ms ?? RANGES[1].ms}
            now={now}
          />
        )}
      </section>

      {/* canto de baixo à esquerda: fica vazio até escolherem um limite */}
      {usage && detailLimit && (
        <section className="usage-panel detail">
          <header className="usage-head">
            <h2>Por hora · {detailLimit.label}</h2>
            <button className="icon" onClick={() => setOpenLimit(null)} title="Fechar">
              ✕
            </button>
          </header>
          <HourlyChart samples={usage.history} id={detailLimit.id} now={now} />
        </section>
      )}

      <UsageInsights />
    </main>
  )
}
