import type {
  ActivityItem,
  FleetOutcome,
  FleetRun,
  FleetSnapshot,
  FleetSpan,
  ServerMsg,
} from '../shared/types'
import { now, uid } from './util'

/** quanto tempo de trabalho o log guarda pra trás */
export const FLEET_WINDOW_MS = 20 * 60 * 1000
const MAX_SPANS = 1500
const MAX_RUNS = 120

/**
 * Diário de bordo da frota: o que cada sessão fez neste turno e nos turnos recentes.
 *
 * A árvore de atividade do manager é efêmera — some no `result` de cada turno. Este log
 * sobrevive ao fim do turno e à recarga da página, que é o que a tela de Agentes precisa
 * pra mostrar o trabalho acontecendo e o que acabou de acontecer.
 */
export class FleetLog {
  private runs: FleetRun[] = []
  private spans = new Map<string, FleetSpan>()
  /** sessão → turno aberto */
  private open = new Map<string, FleetRun>()

  constructor(private emit: (msg: ServerMsg) => void) {}

  /** começou um turno; tudo que vier depois pertence a ele. */
  startRun(sessionId: string): FleetRun {
    this.endRun(sessionId, 'aborted')
    const run: FleetRun = { id: uid(), sessionId, startedAt: now(), endedAt: null, outcome: null }
    this.runs.push(run)
    this.open.set(sessionId, run)
    this.prune()
    this.emit({ type: 'fleet_run', run })
    return run
  }

  endRun(sessionId: string, outcome: FleetOutcome): void {
    const run = this.open.get(sessionId)
    if (!run) return
    this.open.delete(sessionId)
    run.endedAt = now()
    run.outcome = outcome
    // nada continua "rodando" depois que o turno fecha
    for (const span of this.spans.values()) {
      if (span.runId === run.id && span.status === 'running') {
        span.status = outcome === 'error' ? 'error' : 'done'
        span.endedAt = run.endedAt
        this.emit({ type: 'fleet_span', span })
      }
    }
    this.emit({ type: 'fleet_run', run })
  }

  /** um item da árvore de atividade nasceu ou mudou. */
  track(sessionId: string, item: ActivityItem): void {
    const run = this.open.get(sessionId) ?? this.startRun(sessionId)
    const key = `${sessionId}:${item.id}`
    const prev = this.spans.get(key)
    const done = item.status !== 'running'
    // tools: `detail` guarda o input (o que ela foi fazer) e o que voltou vira `result`.
    // subagentes: `detail` é o resumo de progresso, que muda o tempo todo e é o que interessa.
    const frozen = item.kind === 'tool' && Boolean(prev?.detail)
    const span: FleetSpan = {
      key,
      runId: prev?.runId ?? run.id,
      sessionId,
      itemId: item.id,
      parentId: item.parentId,
      kind: item.kind,
      name: item.name,
      detail: frozen ? (prev as FleetSpan).detail : item.detail,
      result: frozen && item.detail ? item.detail : (prev?.result ?? null),
      target: item.target ?? prev?.target ?? null,
      tool: item.tool ?? prev?.tool ?? null,
      status: item.status,
      startedAt: prev?.startedAt ?? item.ts,
      endedAt: done ? (prev?.endedAt ?? now()) : null,
      tokens: item.tokens ?? prev?.tokens ?? 0,
      toolUses: item.toolUses ?? prev?.toolUses ?? 0,
    }
    this.spans.set(key, span)
    this.prune()
    this.emit({ type: 'fleet_span', span })
  }

  /** sessão saiu do ar: fecha o turno dela sem inventar resultado. */
  dropSession(sessionId: string): void {
    this.endRun(sessionId, 'aborted')
  }

  snapshot(): FleetSnapshot {
    this.prune()
    return {
      runs: [...this.runs],
      spans: [...this.spans.values()].sort((a, b) => a.startedAt - b.startedAt),
      windowMs: FLEET_WINDOW_MS,
    }
  }

  /** joga fora o que saiu da janela; o turno aberto nunca é descartado. */
  private prune(): void {
    const cutoff = now() - FLEET_WINDOW_MS
    const liveRuns = new Set([...this.open.values()].map((r) => r.id))
    for (const [key, span] of this.spans) {
      if (span.startedAt < cutoff && !liveRuns.has(span.runId)) this.spans.delete(key)
    }
    if (this.spans.size > MAX_SPANS) {
      const ordered = [...this.spans.values()].sort((a, b) => a.startedAt - b.startedAt)
      for (const span of ordered.slice(0, this.spans.size - MAX_SPANS)) {
        if (!liveRuns.has(span.runId)) this.spans.delete(span.key)
      }
    }
    this.runs = this.runs.filter((r) => r.startedAt >= cutoff || liveRuns.has(r.id))
    if (this.runs.length > MAX_RUNS) this.runs = this.runs.slice(-MAX_RUNS)
  }
}
