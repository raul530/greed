import type {
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
  permissions: Record<string, PermissionRequest>
}

export const initialState: ClientState = {
  connected: false,
  projects: [],
  sessions: {},
  transcripts: {},
  permissions: {},
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
      const permissions: Record<string, PermissionRequest> = {}
      for (const p of msg.permissions) permissions[p.sessionId] = p
      return {
        ...state,
        projects: msg.projects,
        sessions,
        transcripts: msg.transcripts,
        permissions,
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
    case 'permission_request':
      return {
        ...state,
        permissions: { ...state.permissions, [msg.request.sessionId]: msg.request },
      }
    case 'permission_resolved': {
      const cur = state.permissions[msg.sessionId]
      if (!cur || cur.id !== msg.requestId) return state
      const permissions = { ...state.permissions }
      delete permissions[msg.sessionId]
      return { ...state, permissions }
    }
    case 'notify':
      return state
    default:
      return state
  }
}
