import { useState } from 'react'
import type { FleetRun, FleetSpan, SessionMeta } from '../../../../shared/types'
import { FleetFeed } from './FleetFeed'
import { FleetRoster } from './FleetRoster'
import { FleetTimeline } from './FleetTimeline'
import { dur, shortTokens, useFleet, useNow } from './useFleet'

interface Props {
  sessions: Record<string, SessionMeta>
  runs: Record<string, FleetRun>
  spans: Record<string, FleetSpan>
  onOpen: (sessionId: string) => void
}

/** janelas do timeline; 20 min é tudo que o servidor guarda */
const WINDOWS = [
  { id: '2m', label: '2 min', ms: 2 * 60_000 },
  { id: '10m', label: '10 min', ms: 10 * 60_000 },
  { id: '20m', label: '20 min', ms: 20 * 60_000 },
] as const
type WindowId = (typeof WINDOWS)[number]['id']

/** traço do osciloscópio: ops iniciadas por fatia da janela */
function Scope({ pulse }: { pulse: number[] }) {
  const peak = Math.max(1, ...pulse)
  const w = 100
  const h = 28
  const step = w / Math.max(1, pulse.length - 1)
  const points = pulse.map((v, i) => `${(i * step).toFixed(2)},${(h - (v / peak) * h).toFixed(2)}`)
  return (
    <svg className="fl-scope" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label="ritmo de operações">
      <polyline className="fl-scope-fill" points={`0,${h} ${points.join(' ')} ${w},${h}`} />
      <polyline className="fl-scope-line" points={points.join(' ')} />
    </svg>
  )
}

function Vital({ label, value, hot }: { label: string; value: string; hot?: boolean }) {
  return (
    <span className={`fl-vital ${hot ? 'hot' : ''}`}>
      <i>{label}</i>
      <b>{value}</b>
    </span>
  )
}

export function FleetView({ sessions, runs, spans, onOpen }: Props) {
  const [windowId, setWindowId] = useState<WindowId>('10m')
  const windowMs = WINDOWS.find((w) => w.id === windowId)!.ms
  const now = useNow(700)
  const fleet = useFleet(sessions, runs, spans, windowMs, now)
  const oldest = fleet.units.filter((u) => u.live).sort((a, b) => a.startedAt - b.startedAt)[0]
  const peakTool = fleet.histogram[0]

  return (
    <main className="fleet">
      <section className="fl-vitals">
        <div className="fl-vitals-row">
          <Vital label="unidades" value={String(fleet.liveUnits)} hot={fleet.liveUnits > 0} />
          <Vital label="agentes vivos" value={String(fleet.runningAgents)} hot={fleet.runningAgents > 0} />
          <Vital label="tools abertas" value={String(fleet.runningTools)} hot={fleet.runningTools > 0} />
          <Vital label="ops/min" value={String(fleet.opsPerMin)} />
          <Vital label="convocados" value={String(fleet.agentsSpawned)} />
          <Vital label="chamadas" value={String(fleet.toolCalls)} />
          <Vital label="tokens de agente" value={shortTokens(fleet.tokens)} />
          <Vital label="mais longa" value={oldest ? dur(now - oldest.startedAt) : '—'} />
        </div>
        <div className="fl-vitals-scope">
          <Scope pulse={fleet.pulse} />
          <span className="fl-scope-cap">
            {peakTool ? `${peakTool.name} lidera (${peakTool.count})` : 'sem tráfego'}
          </span>
        </div>
      </section>

      <section className="fl-panel fl-panel-timeline">
        <header className="fl-head">
          <h2>linha do tempo</h2>
          <div className="fl-windows">
            {WINDOWS.map((w) => (
              <button
                key={w.id}
                className={`fl-win ${windowId === w.id ? 'active' : ''}`}
                onClick={() => setWindowId(w.id)}
              >
                {w.label}
              </button>
            ))}
          </div>
        </header>
        {fleet.units.length === 0 ? (
          <div className="fl-idle">
            <span className="fl-idle-mark" aria-hidden="true" />
            <p>nenhum agente em campo.</p>
            <p className="fl-idle-hint">
              mande um chat trabalhar e as raias se abrem aqui — uma por subagente convocado.
            </p>
          </div>
        ) : (
          <FleetTimeline
            units={fleet.units}
            windowStart={fleet.windowStart}
            windowEnd={fleet.windowEnd}
            now={now}
          />
        )}
      </section>

      <section className="fl-panel fl-panel-roster">
        <header className="fl-head">
          <h2>convocados</h2>
          <span className="fl-head-note">{fleet.units.length} unidade(s) na janela</span>
        </header>
        {fleet.units.length === 0 ? (
          <p className="fl-empty-line">nada convocado.</p>
        ) : (
          <FleetRoster units={fleet.units} now={now} onOpen={onOpen} />
        )}
      </section>

      <section className="fl-panel fl-panel-feed">
        <header className="fl-head">
          <h2>feed de operações</h2>
          <span className="fl-head-note">mais recente no topo</span>
        </header>
        <FleetFeed feed={fleet.feed} sessions={sessions} now={now} />
      </section>

      <section className="fl-panel fl-panel-recon">
        <header className="fl-head">
          <h2>reconhecimento</h2>
          <span className="fl-head-note">o que a frota tocou</span>
        </header>
        <div className="fl-recon">
          <div className="fl-recon-col">
            <h3>tools mais usadas</h3>
            {fleet.histogram.length === 0 && <p className="fl-empty-line">sem chamadas.</p>}
            {fleet.histogram.map((h) => (
              <div key={h.name} className="fl-hist-row" data-live={h.running > 0}>
                <span className="fl-hist-name">{h.name}</span>
                <span className="fl-hist-bar">
                  <i style={{ width: `${(h.count / fleet.histogram[0].count) * 100}%` }} />
                </span>
                <span className="fl-hist-count">{h.count}</span>
              </div>
            ))}
          </div>
          <div className="fl-recon-col">
            <h3>arquivos varridos</h3>
            {fleet.files.length === 0 && <p className="fl-empty-line">nenhum arquivo tocado.</p>}
            {fleet.files.map((f) => (
              <div key={f.path} className="fl-file-row" data-st={f.status}>
                <span className="fl-file-tool">{f.tool}</span>
                <span className="fl-file-path" data-tip={f.path}>
                  {f.path}
                </span>
                {f.hits > 1 && <span className="fl-file-hits">×{f.hits}</span>}
              </div>
            ))}
          </div>
        </div>
      </section>
    </main>
  )
}
