import type { FleetSpan } from '../../../../shared/types'
import { dur, shortTokens, type FleetUnit } from './useFleet'

interface Props {
  units: FleetUnit[]
  now: number
  onOpen: (sessionId: string) => void
}

const KIND_GLYPH: Record<FleetSpan['kind'], string> = {
  tool: '⚙',
  subagent: '⧉',
  task: '⌁',
}

/** barra de progresso de um subagente: sem total conhecido, mostra fôlego (tools usadas) */
function Meter({ span }: { span: FleetSpan }) {
  const lit = Math.min(12, span.toolUses || 0)
  return (
    <span className="fl-meter" aria-hidden="true">
      {Array.from({ length: 12 }, (_, i) => (
        <i key={i} className={i < lit ? 'on' : ''} />
      ))}
    </span>
  )
}

function Node({
  span,
  unit,
  now,
  depth,
}: {
  span: FleetSpan
  unit: FleetUnit
  now: number
  depth: number
}) {
  const kids = depth < 5 ? unit.childrenOf(span.itemId) : []
  const end = span.endedAt ?? now
  const isAgent = span.kind !== 'tool'
  return (
    <div className="fl-node">
      <div className="fl-node-row" data-st={span.status} data-kind={span.kind}>
        <span className="fl-node-mark">
          {span.status === 'running' ? (
            <i className="fl-spin" />
          ) : span.status === 'error' ? (
            '✗'
          ) : (
            '✓'
          )}
        </span>
        <span className="fl-node-glyph">{KIND_GLYPH[span.kind]}</span>
        <span className="fl-node-name">{span.name}</span>
        {isAgent && span.tool && span.status === 'running' && (
          <span className="fl-node-tool">↳{span.tool}</span>
        )}
        <span className="fl-node-detail" data-tip={span.result ?? undefined}>
          {span.detail || span.target || ''}
        </span>
        {isAgent && span.toolUses > 0 && <Meter span={span} />}
        <span className="fl-node-meta">
          {isAgent && span.tokens > 0 && <em>{shortTokens(span.tokens)}</em>}
          {dur(end - span.startedAt)}
        </span>
      </div>
      {kids.length > 0 && (
        <div className="fl-node-kids">
          {kids.map((k) => (
            <Node key={k.key} span={k} unit={unit} now={now} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  )
}

function Unit({ unit, now, onOpen }: { unit: FleetUnit; now: number; onOpen: Props['onOpen'] }) {
  const run = unit.run
  const end = run?.endedAt ?? now
  const state = unit.live ? 'em campo' : run?.outcome === 'error' ? 'falhou' : 'recolhido'
  return (
    <article className="fl-unit" data-live={unit.live}>
      <header className="fl-unit-head">
        <span className="fl-unit-id">
          {unit.live ? <i className="fl-spin" /> : <i className="fl-unit-dot" />}
          <b>{unit.session.projectName}</b>
        </span>
        <button className="fl-unit-title" onClick={() => onOpen(unit.session.id)} data-tip="Ir pro card no board">
          {unit.session.title}
        </button>
        <span className="fl-unit-state">{state}</span>
      </header>
      <div className="fl-unit-stats">
        <span>
          <i>em voo</i>
          <b>{dur(end - unit.startedAt)}</b>
        </span>
        <span>
          <i>agentes</i>
          <b>{unit.agents}</b>
        </span>
        <span>
          <i>tools</i>
          <b>{unit.tools}</b>
        </span>
        <span>
          <i>tokens</i>
          <b>{shortTokens(unit.tokens)}</b>
        </span>
        <span className="fl-unit-model">{unit.session.model ?? 'padrão'}</span>
      </div>
      <div className="fl-unit-body">
        {unit.roots.length === 0 ? (
          <p className="fl-empty-line">
            {unit.live ? 'pensando — nenhuma tool aberta ainda.' : 'sem operações na janela.'}
          </p>
        ) : (
          unit.roots.map((r) => <Node key={r.key} span={r} unit={unit} now={now} depth={0} />)
        )}
      </div>
    </article>
  )
}

export function FleetRoster({ units, now, onOpen }: Props) {
  return (
    <div className="fl-roster">
      {units.map((u) => (
        <Unit key={u.session.id} unit={u} now={now} onOpen={onOpen} />
      ))}
    </div>
  )
}
