import { useEffect, useMemo, useState } from 'react'
import type { FleetRun, FleetSpan, SessionMeta } from '../../../../shared/types'

/** tools cujo alvo é um arquivo do repo — são elas que alimentam o mapa de recon */
const PATH_TOOLS = new Set([
  'Read',
  'Edit',
  'MultiEdit',
  'Write',
  'NotebookEdit',
  'NotebookRead',
  'Glob',
  'Grep',
  'LS',
])

/** quantas fatias o osciloscópio desenha */
const PULSE_SLOTS = 48

export interface FleetLane {
  /** sessionId, ou sessionId:itemId quando a raia é de um subagente */
  id: string
  sessionId: string
  label: string
  detail: string
  kind: 'main' | 'subagent' | 'task'
  /** as operações da raia (só tools) */
  spans: FleetSpan[]
  /** o próprio subagente: a faixa de vida dele, por baixo das tools */
  envelope: FleetSpan | null
  /** tool que o subagente está usando agora */
  tool: string | null
  live: boolean
  tokens: number
  startedAt: number
}

export interface FleetUnit {
  session: SessionMeta
  run: FleetRun | null
  spans: FleetSpan[]
  running: FleetSpan[]
  roots: FleetSpan[]
  childrenOf: (itemId: string) => FleetSpan[]
  lanes: FleetLane[]
  agents: number
  tools: number
  tokens: number
  startedAt: number
  live: boolean
}

export interface ReconFile {
  path: string
  tool: string
  ts: number
  sessionId: string
  status: FleetSpan['status']
  hits: number
}

export interface FleetModel {
  units: FleetUnit[]
  lanes: FleetLane[]
  spans: FleetSpan[]
  feed: FleetSpan[]
  liveUnits: number
  runningAgents: number
  runningTools: number
  agentsSpawned: number
  toolCalls: number
  tokens: number
  opsPerMin: number
  /** ops iniciadas por fatia da janela; alimenta o traço do osciloscópio */
  pulse: number[]
  histogram: { name: string; count: number; running: number }[]
  files: ReconFile[]
  windowStart: number
  windowEnd: number
}

/** relógio da tela; a janela do timeline anda sozinha mesmo sem evento novo. */
export function useNow(intervalMs: number): number {
  const [ts, setTs] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setTs(Date.now()), intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs])
  return ts
}

/**
 * A raia dona de uma operação; null = tronco da sessão.
 *
 * A raia é a tool que **hospeda** trabalho aninhado (a chamada `Agent`, tipicamente): tanto
 * as tools do subagente quanto o próprio item de subagente penduram nela. Amarrar na tool,
 * e não no item de subagente, é o que faz o agrupamento sobreviver a um `task_started` que
 * nunca chegou.
 */
function ownerOf(
  span: FleetSpan,
  byItem: Map<string, FleetSpan>,
  hosts: Set<string>,
): FleetSpan | null {
  let cur = span
  for (let hop = 0; hop < 8; hop++) {
    if (!cur.parentId) break
    const parent = byItem.get(cur.parentId)
    if (!parent) break
    if (hosts.has(parent.itemId)) return parent
    cur = parent
  }
  if (hosts.has(span.itemId)) return span
  // tarefa de 2º plano sem hospedeiro conhecido ganha raia própria
  return span.kind === 'tool' ? null : span
}

export function buildFleet(
  sessions: Record<string, SessionMeta>,
  runs: Record<string, FleetRun>,
  spansById: Record<string, FleetSpan>,
  windowMs: number,
  nowTs: number,
): FleetModel {
  const windowStart = nowTs - windowMs
  const all = Object.values(spansById)
    .filter((s) => (s.endedAt ?? nowTs) >= windowStart)
    .sort((a, b) => a.startedAt - b.startedAt)

  const bySession = new Map<string, FleetSpan[]>()
  for (const span of all) {
    const list = bySession.get(span.sessionId)
    if (list) list.push(span)
    else bySession.set(span.sessionId, [span])
  }

  const runList = Object.values(runs).sort((a, b) => b.startedAt - a.startedAt)
  const lastRunOf = new Map<string, FleetRun>()
  for (const run of runList) if (!lastRunOf.has(run.sessionId)) lastRunOf.set(run.sessionId, run)

  const units: FleetUnit[] = []
  const lanes: FleetLane[] = []

  for (const [sessionId, spans] of bySession) {
    const session = sessions[sessionId]
    if (!session) continue // sessão apagada: o log ainda tem rastro, a tela não precisa
    const byItem = new Map(spans.map((s) => [s.itemId, s]))
    // tools com trabalho pendurado nelas: cada uma abre uma raia
    const hosts = new Set<string>()
    for (const s of spans) if (s.parentId && byItem.has(s.parentId)) hosts.add(s.parentId)
    // hospedeira → o item de subagente que nasceu dela, quando o SDK mandou um
    const agentOf = new Map<string, FleetSpan>()
    for (const s of spans) if (s.kind !== 'tool' && s.parentId) agentOf.set(s.parentId, s)
    const run = lastRunOf.get(sessionId) ?? null
    const running = spans.filter((s) => s.status === 'running')
    const roots = spans.filter((s) => !s.parentId || !byItem.has(s.parentId))

    // raias: o tronco da sessão, mais uma por hospedeira
    const mainSpans: FleetSpan[] = []
    const subLanes = new Map<string, FleetLane>()
    for (const span of spans) {
      const owner = ownerOf(span, byItem, hosts)
      if (!owner) {
        mainSpans.push(span)
        continue
      }
      const agent = agentOf.get(owner.itemId) ?? null
      let lane = subLanes.get(owner.itemId)
      if (!lane) {
        lane = {
          id: `${sessionId}:${owner.itemId}`,
          sessionId,
          label: agent?.name ?? owner.name,
          detail: agent?.detail ?? owner.detail,
          kind: (agent ?? owner).kind === 'task' ? 'task' : 'subagent',
          spans: [],
          envelope: owner,
          tool: null,
          live: false,
          tokens: 0,
          startedAt: owner.startedAt,
        }
        subLanes.set(owner.itemId, lane)
      }
      // a hospedeira é a moldura da raia; o item de subagente só descreve o que rola dentro
      if (span.itemId === owner.itemId) lane.envelope = span
      else if (span === agent) {
        lane.label = span.name
        lane.detail = span.detail
        lane.tokens = span.tokens
        lane.tool = span.tool
      } else lane.spans.push(span)
      if (span.status === 'running') lane.live = true
    }

    const trunk: FleetLane = {
      id: sessionId,
      sessionId,
      label: 'tronco',
      detail: session.title,
      kind: 'main',
      spans: mainSpans,
      envelope: null,
      tool: null,
      live: mainSpans.some((s) => s.status === 'running'),
      tokens: 0,
      startedAt: run?.startedAt ?? mainSpans[0]?.startedAt ?? nowTs,
    }
    const unitLanes = [
      trunk,
      ...[...subLanes.values()].sort((a, b) => a.startedAt - b.startedAt),
    ].filter((lane) => lane.spans.length > 0 || lane.envelope)

    lanes.push(...unitLanes)
    units.push({
      session,
      run,
      spans,
      running,
      roots,
      childrenOf: (itemId: string) => spans.filter((s) => s.parentId === itemId),
      lanes: unitLanes,
      agents: subLanes.size,
      tools: spans.filter((s) => s.kind === 'tool').length,
      tokens: spans.reduce((sum, s) => sum + (s.kind === 'tool' ? 0 : s.tokens), 0),
      startedAt: run?.startedAt ?? spans[0].startedAt,
      live: running.length > 0 || session.status === 'working',
    })
  }

  // sessões trabalhando que ainda não produziram nada aparecem mesmo assim
  for (const session of Object.values(sessions)) {
    if (session.status !== 'working' || bySession.has(session.id)) continue
    const run = lastRunOf.get(session.id) ?? null
    units.push({
      session,
      run,
      spans: [],
      running: [],
      roots: [],
      childrenOf: () => [],
      lanes: [],
      agents: 0,
      tools: 0,
      tokens: 0,
      startedAt: run?.startedAt ?? nowTs,
      live: true,
    })
  }

  units.sort((a, b) => {
    if (a.live !== b.live) return a.live ? -1 : 1
    return b.startedAt - a.startedAt
  })

  // pulso: quantas ops começaram em cada fatia da janela
  const slot = windowMs / PULSE_SLOTS
  const pulse = new Array<number>(PULSE_SLOTS).fill(0)
  for (const span of all) {
    const i = Math.floor((span.startedAt - windowStart) / slot)
    if (i >= 0 && i < PULSE_SLOTS) pulse[i] += 1
  }

  const minuteAgo = nowTs - 60_000
  const counts = new Map<string, { count: number; running: number }>()
  for (const span of all) {
    if (span.kind !== 'tool') continue
    const cur = counts.get(span.name) ?? { count: 0, running: 0 }
    cur.count += 1
    if (span.status === 'running') cur.running += 1
    counts.set(span.name, cur)
  }

  const seen = new Map<string, ReconFile>()
  for (const span of [...all].reverse()) {
    if (!span.target || !PATH_TOOLS.has(span.name)) continue
    const cur = seen.get(span.target)
    if (cur) {
      cur.hits += 1
      continue
    }
    seen.set(span.target, {
      path: span.target,
      tool: span.name,
      ts: span.startedAt,
      sessionId: span.sessionId,
      status: span.status,
      hits: 1,
    })
  }

  return {
    units,
    lanes,
    spans: all,
    feed: [...all].reverse().slice(0, 120),
    liveUnits: units.filter((u) => u.live).length,
    runningAgents: all.filter((s) => s.kind !== 'tool' && s.status === 'running').length,
    runningTools: all.filter((s) => s.kind === 'tool' && s.status === 'running').length,
    agentsSpawned: all.filter((s) => s.kind !== 'tool').length,
    toolCalls: all.filter((s) => s.kind === 'tool').length,
    tokens: all.reduce((sum, s) => sum + (s.kind !== 'tool' ? s.tokens : 0), 0),
    opsPerMin: all.filter((s) => s.startedAt >= minuteAgo).length,
    pulse,
    histogram: [...counts.entries()]
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10),
    files: [...seen.values()].sort((a, b) => b.ts - a.ts).slice(0, 40),
    windowStart,
    windowEnd: nowTs,
  }
}

export function useFleet(
  sessions: Record<string, SessionMeta>,
  runs: Record<string, FleetRun>,
  spans: Record<string, FleetSpan>,
  windowMs: number,
  nowTs: number,
): FleetModel {
  return useMemo(
    () => buildFleet(sessions, runs, spans, windowMs, nowTs),
    [sessions, runs, spans, windowMs, nowTs],
  )
}

export function clock(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** "4s" / "1m12" / "2h03" — duração curta o bastante pra caber numa coluna */
export function dur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`
}

export function shortTokens(n: number): string {
  if (n <= 0) return '—'
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}
