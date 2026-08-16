import type {
  ActivityItem,
  PermissionRequest,
  Project,
  ServerMsg,
  SessionMeta,
  TranscriptEntry,
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
}

export const initialState: ClientState = {
  connected: false,
  projects: [],
  sessions: {},
  transcripts: {},
  permissions: {},
  activity: {},
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
    case 'activity_clear': {
      const activity = { ...state.activity }
      delete activity[msg.sessionId]
      return { ...state, activity }
    }
    case 'notify':
      return state
    default:
      return state
  }
}
