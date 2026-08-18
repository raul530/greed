import type {
  ActivityItem,
  BtwExchange,
  FleetRun,
  FleetSpan,
  PermissionRequest,
  Project,
  ServerMsg,
  SessionMeta,
  TranscriptEntry,
  UsageSnapshot,
} from '../../shared/types'

export interface ClientState {
  connected: boolean
  projects: Project[]
  sessions: Record<string, SessionMeta>
  transcripts: Record<string, TranscriptEntry[]>
  /** pedidos de permissão em aberto por sessão (um turno pode ter vários) */
  permissions: Record<string, PermissionRequest[]>
  /** árvore de atividade viva por sessão (efêmera) */
  activity: Record<string, ActivityItem[]>
  /** perguntas de canto (/btw) por sessão */
  btw: Record<string, BtwExchange[]>
  /** diário de bordo da frota: turnos e trechos de trabalho recentes, por chave */
  fleetRuns: Record<string, FleetRun>
  fleetSpans: Record<string, FleetSpan>
  /** consumo da assinatura (null enquanto não chegou a 1ª leitura) */
  usage: UsageSnapshot | null
  usageError: string | null
}

export const initialState: ClientState = {
  connected: false,
  projects: [],
  sessions: {},
  transcripts: {},
  permissions: {},
  activity: {},
  btw: {},
  fleetRuns: {},
  fleetSpans: {},
  usage: null,
  usageError: null,
}

/** o log da frota é infinito no servidor só até a janela; aqui a poda evita crescer sem fim */
const SPAN_CAP = 2200
const SPAN_KEEP = 1400
const RUN_CAP = 300
const RUN_KEEP = 180

function capRecord<T>(rows: Record<string, T>, cap: number, keep: number, at: (v: T) => number) {
  if (Object.keys(rows).length <= cap) return rows
  const newest = Object.entries(rows)
    .sort((a, b) => at(b[1]) - at(a[1]))
    .slice(0, keep)
  return Object.fromEntries(newest) as Record<string, T>
}

export type Action = { type: 'ws_status'; connected: boolean } | { type: 'server'; msg: ServerMsg }

function upsertEntry(entries: TranscriptEntry[], entry: TranscriptEntry): TranscriptEntry[] {
  const i = entries.findIndex((e) => e.id === entry.id)
  if (i === -1) return [...entries, entry]
  const next = entries.slice()
  next[i] = entry
  return next
}

export function reducer(state: ClientState, action: Action): ClientState {
  if (action.type === 'ws_status') return { ...state, connected: action.connected }

  const msg = action.msg
  switch (msg.type) {
    case 'snapshot': {
      const sessions: Record<string, SessionMeta> = {}
      for (const s of msg.sessions) sessions[s.id] = s
      const permissions: Record<string, PermissionRequest[]> = {}
      for (const p of msg.permissions) (permissions[p.sessionId] ??= []).push(p)
      return {
        ...state,
        projects: msg.projects,
        sessions,
        transcripts: msg.transcripts,
        permissions,
        activity: msg.activity ?? {},
      }
    }
    case 'projects':
      return { ...state, projects: msg.projects }
    case 'session':
      return { ...state, sessions: { ...state.sessions, [msg.session.id]: msg.session } }
    case 'transcript':
      return { ...state, transcripts: { ...state.transcripts, [msg.sessionId]: msg.entries } }
    case 'entry': {
      const entries = state.transcripts[msg.sessionId] ?? []
      return {
        ...state,
        transcripts: { ...state.transcripts, [msg.sessionId]: upsertEntry(entries, msg.entry) },
      }
    }
    case 'delta': {
      const entries = state.transcripts[msg.sessionId] ?? []
      const i = entries.findIndex((e) => e.id === msg.entryId)
      let next: TranscriptEntry[]
      if (i === -1) {
        next = [
          ...entries,
          { kind: 'assistant', id: msg.entryId, text: msg.text, ts: Date.now(), streaming: true },
        ]
      } else {
        const cur = entries[i]
        if (cur.kind !== 'assistant') return state
        next = entries.slice()
        next[i] = { ...cur, text: cur.text + msg.text, streaming: true }
      }
      return { ...state, transcripts: { ...state.transcripts, [msg.sessionId]: next } }
    }
    case 'permission_request': {
      const list = state.permissions[msg.request.sessionId] ?? []
      if (list.some((p) => p.id === msg.request.id)) return state
      return {
        ...state,
        permissions: { ...state.permissions, [msg.request.sessionId]: [...list, msg.request] },
      }
    }
    case 'permission_resolved': {
      const list = state.permissions[msg.sessionId]
      if (!list) return state
      const next = list.filter((p) => p.id !== msg.requestId)
      const permissions = { ...state.permissions }
      if (next.length > 0) permissions[msg.sessionId] = next
      else delete permissions[msg.sessionId]
      return { ...state, permissions }
    }
    case 'activity': {
      const list = state.activity[msg.sessionId] ?? []
      const i = list.findIndex((a) => a.id === msg.item.id)
      const next = i === -1 ? [...list, msg.item] : list.slice()
      if (i !== -1) next[i] = msg.item
      return { ...state, activity: { ...state.activity, [msg.sessionId]: next } }
    }
    case 'btw': {
      const list = state.btw[msg.exchange.sessionId] ?? []
      const i = list.findIndex((b) => b.id === msg.exchange.id)
      const next = i === -1 ? [...list, msg.exchange] : list.slice()
      if (i !== -1) next[i] = msg.exchange
      return { ...state, btw: { ...state.btw, [msg.exchange.sessionId]: next } }
    }
    case 'fleet_snapshot': {
      const fleetRuns: Record<string, FleetRun> = {}
      for (const r of msg.fleet.runs) fleetRuns[r.id] = r
      const fleetSpans: Record<string, FleetSpan> = {}
      for (const sp of msg.fleet.spans) fleetSpans[sp.key] = sp
      return { ...state, fleetRuns, fleetSpans }
    }
    case 'fleet_run': {
      const runs = { ...state.fleetRuns, [msg.run.id]: msg.run }
      return { ...state, fleetRuns: capRecord(runs, RUN_CAP, RUN_KEEP, (r) => r.startedAt) }
    }
    case 'fleet_span': {
      const spans = { ...state.fleetSpans, [msg.span.key]: msg.span }
      return { ...state, fleetSpans: capRecord(spans, SPAN_CAP, SPAN_KEEP, (sp) => sp.startedAt) }
    }
    case 'activity_clear': {
      const activity = { ...state.activity }
      delete activity[msg.sessionId]
      return { ...state, activity }
    }
    case 'usage':
      // erro sem leitura nova mantém o último snapshot na tela (marcado como velho)
      return { ...state, usage: msg.usage ?? state.usage, usageError: msg.error }
    case 'notify':
      return state
    default:
      return state
  }
}
