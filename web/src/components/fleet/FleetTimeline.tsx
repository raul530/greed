import type { FleetSpan } from '../../../../shared/types'
import { clock, dur, shortTokens, type FleetUnit } from './useFleet'

interface Props {
  units: FleetUnit[]
  windowStart: number
  windowEnd: number
  now: number
}

const LANE_GLYPH = { main: '▮', subagent: '⧉', task: '⌁' } as const

/** quantas marcas de tempo a régua desenha */
const TICKS = 6

function pct(ts: number, start: number, span: number): number {
  return ((ts - start) / span) * 100
}

function Bar({
  span,
  start,
  width,
  now,
  envelope,
}: {
  span: FleetSpan
  start: number
  width: number
  now: number
  envelope?: boolean
}) {
  const left = pct(span.startedAt, start, width)
  const end = span.endedAt ?? now
  const size = Math.max(0.5, pct(end, start, width) - left)
  if (left + size < 0 || left > 100) return null
  const label = span.detail || span.target || span.name
  return (
    <span
      className={`fl-bar ${envelope ? 'envelope' : ''}`}
      data-st={span.status}
      data-kind={span.kind}
      style={{ left: `${Math.max(0, left)}%`, width: `${Math.min(size, 100 - Math.max(0, left))}%` }}
      data-tip={`${span.name} · ${dur(end - span.startedAt)}${label ? ` · ${label}` : ''}`}
    >
      {!envelope && <i className="fl-bar-name">{span.name}</i>}
    </span>
  )
}

export function FleetTimeline({ units, windowStart, windowEnd, now }: Props) {
  const width = Math.max(1, windowEnd - windowStart)
  const ticks = Array.from({ length: TICKS + 1 }, (_, i) => windowStart + (width * i) / TICKS)

  return (
    <div className="fl-timeline">
      <div className="fl-ruler">
        <span className="fl-lane-label fl-ruler-corner">janela</span>
        <div className="fl-track fl-ruler-track">
          {ticks.map((t, i) => (
            <span key={t} className="fl-tick" style={{ left: `${(i / TICKS) * 100}%` }}>
              <i>{i === TICKS ? 'agora' : clock(t)}</i>
            </span>
          ))}
        </div>
      </div>

      <div className="fl-lanes">
        {units.map((unit) => (
          <div key={unit.session.id} className="fl-unit-lanes" data-live={unit.live}>
            <div className="fl-unit-tag">
              <b>{unit.session.projectName}</b>
              <span>{unit.session.title}</span>
              {unit.live && <i className="fl-live-dot" aria-hidden="true" />}
            </div>
            {unit.lanes.length === 0 && (
              <div className="fl-lane">
                <span className="fl-lane-label fl-lane-idle">aquecendo…</span>
                <div className="fl-track" />
              </div>
            )}
            {unit.lanes.map((lane) => (
              <div key={lane.id} className="fl-lane" data-kind={lane.kind} data-live={lane.live}>
                <span className="fl-lane-label" data-tip={lane.detail || lane.label}>
                  <i className="fl-lane-glyph">{LANE_GLYPH[lane.kind]}</i>
                  <b>{lane.label}</b>
                  {lane.live && lane.tool && <em className="fl-lane-tool">{lane.tool}</em>}
                  {lane.tokens > 0 && <em>{shortTokens(lane.tokens)}</em>}
                </span>
                <div className="fl-track">
                  {ticks.slice(1, TICKS).map((t, i) => (
                    <span
                      key={t}
                      className="fl-grid"
                      style={{ left: `${((i + 1) / TICKS) * 100}%` }}
                    />
                  ))}
                  {lane.envelope && (
                    <Bar
                      key={lane.envelope.key}
                      span={lane.envelope}
                      start={windowStart}
                      width={width}
                      now={now}
                      envelope
                    />
                  )}
                  {lane.spans.map((s) => (
                    <Bar key={s.key} span={s} start={windowStart} width={width} now={now} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
