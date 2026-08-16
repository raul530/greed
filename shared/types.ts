// Modelos e protocolo WebSocket compartilhados entre server e web.

export interface Project {
  id: string
  name: string
  path: string
  createdAt: number
}

export type CardStatus = 'idle' | 'working' | 'waiting'
export type Attention = 'finished' | 'waiting' | null

export interface SessionMeta {
  id: string
  projectId: string
  projectName: string
  title: string
  sdkSessionId: string | null
  /** id do modelo (ex.: 'claude-opus-5', 'claude-fable-5'); null = padrão da assinatura */
  model: string | null
  /** nível de esforço/raciocínio ('low'..'max'); null = padrão do modelo (high) */
  effort: string | null
  /** política de permissão: 'default' (pergunta) | 'acceptEdits' | 'bypassPermissions' (não pergunta) */
  permissionMode: string
  /** pasta do código onde o agente trabalha; null = usa a pasta do projeto (contexto) */
  codebasePath: string | null
  open: boolean
  status: CardStatus
  attention: Attention
  createdAt: number
  updatedAt: number
  lastError: string | null
}

export type ActivityStatus = 'running' | 'done' | 'error'
export type ActivityKind = 'tool' | 'subagent' | 'task'

/** item efêmero da árvore de atividade de um turno (não persiste no transcript). */
export interface ActivityItem {
  id: string // tool_use_id (tools) ou task_id (subagents/tasks em 2º plano)
  parentId: string | null // parent_tool_use_id → aninhamento
  kind: ActivityKind
  name: string
  detail: string
  status: ActivityStatus
  tokens?: number
  toolUses?: number
  elapsedMs?: number
  background?: boolean
  ts: number
  updatedAt: number
}

export type TranscriptEntry =
  | { kind: 'user'; id: string; text: string; ts: number }
  | { kind: 'assistant'; id: string; text: string; ts: number; streaming?: boolean }
  | {
      kind: 'tool'
      id: string // = id do bloco tool_use (correlaciona tool_result/tool_progress)
      name: string
      summary: string
      status: ActivityStatus
      result?: string
      ts: number
    }
  | {
      kind: 'permission'
      id: string
      toolName: string
      summary: string
      decision: 'allow' | 'deny' | null
      ts: number
    }
  | { kind: 'info'; id: string; text: string; ts: number }
  | { kind: 'error'; id: string; text: string; ts: number }

export interface PermissionRequest {
  id: string
  sessionId: string
  toolName: string
  input: unknown
  summary: string
  ts: number
}

export type ClientMsg =
  | { type: 'user_message'; sessionId: string; text: string }
  | {
      type: 'permission_response'
      sessionId: string
      requestId: string
      behavior: 'allow' | 'deny'
    }
  | { type: 'interrupt'; sessionId: string }
  | { type: 'mark_read'; sessionId: string }
  | { type: 'set_model'; sessionId: string; model: string | null }
  | { type: 'set_effort'; sessionId: string; effort: string | null }
  | { type: 'set_permission_mode'; sessionId: string; mode: string }

export type ServerMsg =
  | {
      type: 'snapshot'
      projects: Project[]
      sessions: SessionMeta[]
      transcripts: Record<string, TranscriptEntry[]>
      permissions: PermissionRequest[]
      activity: Record<string, ActivityItem[]>
    }
  | { type: 'session'; session: SessionMeta }
  | { type: 'transcript'; sessionId: string; entries: TranscriptEntry[] }
  | { type: 'entry'; sessionId: string; entry: TranscriptEntry }
  | { type: 'delta'; sessionId: string; entryId: string; text: string }
  | { type: 'permission_request'; request: PermissionRequest }
  | {
      type: 'permission_resolved'
      sessionId: string
      requestId: string
      decision: 'allow' | 'deny'
    }
  | { type: 'notify'; sessionId: string; kind: 'finished' | 'waiting'; title: string; body: string }
  | { type: 'projects'; projects: Project[] }
  | { type: 'activity'; sessionId: string; item: ActivityItem }
  | { type: 'activity_clear'; sessionId: string }
