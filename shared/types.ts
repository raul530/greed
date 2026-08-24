// Modelos e protocolo WebSocket compartilhados entre server e web.

export interface Project {
  id: string
  name: string
  path: string
  createdAt: number
}

/** Uma conta Claude: pasta de config (~/.claude*) que vai em CLAUDE_CONFIG_DIR. */
export interface Profile {
  dir: string
  /** nome curto pra UI: 'padrão' para ~/.claude, o sufixo para ~/.claude-<nome> */
  name: string
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
  /** pasta de config do Claude (CLAUDE_CONFIG_DIR) — qual conta paga esta sessão; null = perfil padrão */
  profile: string | null
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
  /** alvo concreto da tool: caminho, padrão, url ou comando — alimenta o mapa de recon */
  target?: string
  /** subagentes: a tool que ele está usando agora (o nome dele não muda) */
  tool?: string
  tokens?: number
  toolUses?: number
  elapsedMs?: number
  background?: boolean
  ts: number
  updatedAt: number
}

/** como um turno terminou, do ponto de vista do diário de bordo */
export type FleetOutcome = 'ok' | 'error' | 'aborted'

/** um turno de uma sessão: do prompt até o result */
export interface FleetRun {
  id: string
  sessionId: string
  startedAt: number
  endedAt: number | null
  outcome: FleetOutcome | null
}

/** um trecho de trabalho (tool, subagente ou task) com começo e fim medidos no relógio */
export interface FleetSpan {
  /** sessionId:itemId — chave única no log */
  key: string
  runId: string
  sessionId: string
  itemId: string
  parentId: string | null
  kind: ActivityKind
  name: string
  /** o que a operação está fazendo: input da tool, ou o resumo de progresso do subagente */
  detail: string
  /** prévia do que voltou; só depois que termina */
  result: string | null
  target: string | null
  /** subagentes: tool em uso no momento */
  tool: string | null
  status: ActivityStatus
  startedAt: number
  endedAt: number | null
  tokens: number
  toolUses: number
}

export interface FleetSnapshot {
  runs: FleetRun[]
  spans: FleetSpan[]
  /** quanto tempo pra trás o servidor guarda */
  windowMs: number
}

/** anexo indo pro modelo: texto embutido (content) ou arquivo salvo (path) */
export interface MsgAttachment {
  name: string
  content?: string
  path?: string
}

/** anexo de uma mensagem — só o rótulo; o conteúdo vai pro modelo, não pra tela */
export interface AttachmentRef {
  name: string
  kind: 'inline' | 'file'
}

export type TranscriptEntry =
  | { kind: 'user'; id: string; text: string; ts: number; attachments?: AttachmentRef[] }
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
  /** a base de conhecimento do projeto mudou (documento indexado ou fatos aprendidos) */
  | { kind: 'memory'; id: string; text: string; source: 'doc' | 'facts'; ts: number }
  | { kind: 'error'; id: string; text: string; ts: number }

export interface PermissionRequest {
  id: string
  sessionId: string
  toolName: string
  input: unknown
  summary: string
  ts: number
}

/** uma pergunta de canto (/btw) e a resposta dela, fora do chat principal */
export interface BtwExchange {
  id: string
  sessionId: string
  question: string
  answer: string
  status: 'asking' | 'done' | 'error'
  ts: number
}

/** um limite de uso da assinatura (janela de 5h, semanal, semanal por modelo…) */
export interface UsageLimit {
  /** id estável — serve de chave no histórico */
  id: string
  label: string
  group: 'session' | 'weekly' | 'other'
  percent: number
  /** 'normal' | 'warning' | 'critical' — como a API classifica */
  severity: string
  resetsAt: number | null
  /** é o limite que o uso atual está consumindo */
  active: boolean
}

/** créditos extras (pay-as-you-go), quando a conta tem isso ligado */
export interface UsageExtra {
  enabled: boolean
  percent: number | null
  usedMinor: number | null
  limitMinor: number | null
  currency: string | null
}

export interface UsageSample {
  ts: number
  /** percentual por id de limite naquele instante */
  values: Record<string, number>
}

export interface UsageSnapshot {
  fetchedAt: number
  limits: UsageLimit[]
  extra: UsageExtra | null
  history: UsageSample[]
}

/** uma linha do ranking de consumo (chat, projeto ou modelo) */
export interface UsageRow {
  label: string
  /** fatia do consumo ponderado, em % */
  share: number
  tokens: number
  calls: number
}

/** observação sobre o perfil de uso; não soma com as outras */
export interface InsightBucket {
  label: string
  hint: string
}

export interface InsightsReport {
  generatedAt: number
  windowMs: number
  calls: number
  tokens: number
  byChat: UsageRow[]
  byProject: UsageRow[]
  byModel: UsageRow[]
  characteristics: InsightBucket[]
}

export type ClientMsg =
  | {
      type: 'user_message'
      sessionId: string
      text: string
      /** conteúdo dos anexos: vai pro prompt do modelo, nunca pro balão da mensagem */
      attachments?: MsgAttachment[]
    }
  | { type: 'btw'; sessionId: string; text: string }
  | {
      type: 'permission_response'
      sessionId: string
      requestId: string
      behavior: 'allow' | 'deny'
    }
  | { type: 'interrupt'; sessionId: string }
  | { type: 'mark_read'; sessionId: string }
  | { type: 'set_title'; sessionId: string; title: string }
  | { type: 'set_model'; sessionId: string; model: string | null }
  | { type: 'set_effort'; sessionId: string; effort: string | null }
  | { type: 'set_profile'; sessionId: string; profile: string | null }
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
  | { type: 'session_gone'; sessionId: string }
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
  /** diário de bordo da frota: estado inicial e as atualizações que vêm depois */
  | { type: 'fleet_snapshot'; fleet: FleetSnapshot }
  | { type: 'fleet_span'; span: FleetSpan }
  | { type: 'fleet_run'; run: FleetRun }
  | { type: 'btw'; exchange: BtwExchange }
  /** consumo da assinatura; usage null + error quando não deu pra ler */
  | { type: 'usage'; usage: UsageSnapshot | null; error: string | null }
