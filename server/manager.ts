import {
  query,
  type EffortLevel,
  type PermissionMode,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type {
  PermissionRequest,
  ServerMsg,
  SessionMeta,
  TranscriptEntry,
} from '../shared/types'
import { ingestDoc, renderDocCatalog } from './docs'
import type { Hub } from './hub'
import { loadProjectMcpServers } from './mcp'
import { captureTurn, renderMemory } from './memory'
import type { ProjectRegistry } from './projects'
import { store } from './store'
import { fallbackTitle, generateTitle } from './titles'
import { now, summarizeToolInput, truncate, uid } from './util'

const PERM_MODES = new Set(['default', 'acceptEdits', 'bypassPermissions'])
function normalizePermMode(mode?: string): string {
  return mode && PERM_MODES.has(mode) ? mode : 'default'
}

/** Fila async que alimenta o modo de input streaming do SDK. */
class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = []
  private resolvers: ((r: IteratorResult<T>) => void)[] = []
  private done = false

  push(item: T): void {
    if (this.done) return
    const resolve = this.resolvers.shift()
    if (resolve) resolve({ value: item, done: false })
    else this.items.push(item)
  }

  end(): void {
    if (this.done) return
    this.done = true
    for (const resolve of this.resolvers.splice(0)) {
      resolve({ value: undefined as never, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.items.length > 0) {
          return Promise.resolve({ value: this.items.shift() as T, done: false })
        }
        if (this.done) return Promise.resolve({ value: undefined as never, done: true })
        return new Promise((resolve) => this.resolvers.push(resolve))
      },
    }
  }
}

interface PendingPerm {
  request: PermissionRequest
  resolve: (r: PermissionResult) => void
}

interface LiveSession {
  queue: AsyncQueue<SDKUserMessage>
  q: Query
  abort: AbortController
  /** pedidos de permissão em aberto, chaveados por request.id (um turno pode ter vários) */
  pending: Map<string, PendingPerm>
  currentAssistantId: string | null
  /** incrementa a cada mensagem do usuário; usado para timers não confundirem turnos */
  turnSeq: number
}

export class SessionManager {
  private sessions = new Map<string, SessionMeta>()
  private transcripts = new Map<string, TranscriptEntry[]>()
  private live = new Map<string, LiveSession>()
  /** sessões cujo query() foi encerrado mas ainda está drenando (janela de graça antes do abort) */
  private ending = new Map<string, { live: LiveSession; timer: NodeJS.Timeout }>()

  constructor(
    private hub: Hub,
    private projects: ProjectRegistry,
  ) {
    for (const s of store.loadSessions()) {
      // o servidor acabou de subir: nada está rodando
      s.status = 'idle'
      s.model = s.model ?? null // compat com sessões salvas antes do seletor de modelo
      s.effort = s.effort ?? null
      s.permissionMode = s.permissionMode ?? 'default'
      this.sessions.set(s.id, s)
    }
  }

  snapshot(): ServerMsg {
    const sessions = [...this.sessions.values()]
    const transcripts: Record<string, TranscriptEntry[]> = {}
    for (const s of sessions) {
      if (s.open) transcripts[s.id] = this.transcript(s.id)
    }
    const permissions: PermissionRequest[] = []
    for (const live of this.live.values()) {
      for (const p of live.pending.values()) permissions.push(p.request)
    }
    return { type: 'snapshot', projects: this.projects.list(), sessions, transcripts, permissions }
  }

  createSession(
    projectId: string,
    prompt: string,
    model?: string | null,
    effort?: string | null,
    permissionMode?: string,
  ): SessionMeta {
    const project = this.projects.get(projectId)
    if (!project) throw new Error('Projeto não encontrado')
    const session: SessionMeta = {
      id: uid(),
      projectId,
      projectName: project.name,
      title: fallbackTitle(prompt),
      sdkSessionId: null,
      model: model && model.trim() ? model.trim() : null,
      effort: effort && effort.trim() ? effort.trim() : null,
      // default do app: não pedir permissão (autônomo)
      permissionMode: normalizePermMode(permissionMode ?? 'bypassPermissions'),
      open: true,
      status: 'idle',
      attention: null,
      createdAt: now(),
      updatedAt: now(),
      lastError: null,
    }
    this.sessions.set(session.id, session)
    this.save()
    this.hub.broadcast({ type: 'session', session })
    this.sendUserMessage(session.id, prompt)
    void generateTitle(prompt).then((title) => {
      if (!title) return
      const s = this.sessions.get(session.id)
      if (s) this.touch(s, { title })
    })
    return session
  }

  sendUserMessage(sessionId: string, text: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    const clean = text.trim()
    if (!clean) return
    this.addEntry(sessionId, { kind: 'user', id: uid(), text: clean, ts: now() })
    const live = this.live.get(sessionId) ?? this.startLive(session)
    if (!live) return
    live.turnSeq += 1
    live.queue.push({
      type: 'user',
      message: { role: 'user', content: clean },
      parent_tool_use_id: null,
    })
    // não rebaixa de 'waiting' se ainda há permissão pendente
    const status = live.pending.size > 0 ? session.status : 'working'
    this.touch(session, { status, attention: null, lastError: null })
  }

  respondPermission(sessionId: string, requestId: string, behavior: 'allow' | 'deny'): void {
    const live = this.live.get(sessionId)
    const entry = live?.pending.get(requestId)
    if (!entry) return
    if (behavior === 'allow') {
      entry.resolve({
        behavior: 'allow',
        updatedInput: entry.request.input as Record<string, unknown>,
      })
    } else {
      entry.resolve({ behavior: 'deny', message: 'O usuário negou a permissão no Greed.' })
    }
  }

  interrupt(sessionId: string): void {
    const live = this.live.get(sessionId)
    if (!live) return
    this.rejectAllPending(live, 'Interrompido pelo usuário.')
    void live.q.interrupt().catch(() => {})
  }

  markRead(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session && session.attention) this.touch(session, { attention: null })
  }

  /** caminho da pasta (working dir) do projeto de uma sessão, para salvar anexos. */
  projectPathForSession(sessionId: string): string | null {
    const session = this.sessions.get(sessionId)
    if (!session) return null
    return this.projects.get(session.projectId)?.path ?? null
  }

  /** ingesta um anexo salvo na base de conhecimento do projeto (extrai texto + indexa). */
  ingestAttachment(sessionId: string, name: string, relPath: string, bytes: Buffer): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    const project = this.projects.get(session.projectId)
    if (!project) return
    ingestDoc({
      projectId: session.projectId,
      projectName: session.projectName,
      projectPath: project.path,
      sessionId,
      name,
      relPath,
      bytes,
    })
  }

  setModel(sessionId: string, model: string | null): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    const next = model && model.trim() ? model.trim() : null
    if (session.model === next) return
    this.touch(session, { model: next })
    // se há uma sessão viva, aplica já (vale a partir do próximo turno)
    const live = this.live.get(sessionId)
    if (live) void live.q.setModel(next ?? undefined).catch(() => {})
  }

  setEffort(sessionId: string, effort: string | null): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    const next = effort && effort.trim() ? effort.trim() : null
    if (session.effort === next) return
    this.touch(session, { effort: next })
    const live = this.live.get(sessionId)
    // aplica ao vivo (escopo da sessão); vale a partir do próximo turno
    if (live) void live.q.applyFlagSettings({ effortLevel: next as EffortLevel | null }).catch(() => {})
  }

  setPermissionMode(sessionId: string, mode: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    const next = normalizePermMode(mode)
    if (session.permissionMode === next) return
    this.touch(session, { permissionMode: next })
    const live = this.live.get(sessionId)
    if (!live) return
    void live.q.setPermissionMode(next as PermissionMode).catch(() => {})
    // ao ligar "não perguntar", libera qualquer pedido que já esteja aberto no card
    if (next === 'bypassPermissions' && live.pending.size > 0) {
      for (const entry of [...live.pending.values()]) {
        entry.resolve({
          behavior: 'allow',
          updatedInput: entry.request.input as Record<string, unknown>,
        })
      }
    }
  }

  closeCard(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.touch(session, { open: false, attention: null })
    const live = this.live.get(sessionId)
    // trabalhando ou aguardando permissão: continua em background; encerra no fim do turno
    if (live && session.status === 'idle' && live.pending.size === 0) this.endLive(sessionId)
  }

  reopenCard(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.touch(session, { open: true })
    this.hub.broadcast({ type: 'transcript', sessionId, entries: this.transcript(sessionId) })
    const live = this.live.get(sessionId)
    if (live) {
      for (const p of live.pending.values()) {
        this.hub.broadcast({ type: 'permission_request', request: p.request })
      }
    }
  }

  shutdown(): void {
    for (const [sessionId, live] of this.live) {
      this.rejectAllPending(live, 'Servidor encerrando.')
      live.queue.end()
      live.abort.abort()
      this.live.delete(sessionId)
    }
    for (const [, e] of this.ending) {
      clearTimeout(e.timer)
      e.live.abort.abort()
    }
    this.ending.clear()
  }

  // ── internos ────────────────────────────────────────────────────────────

  private save(): void {
    store.saveSessions([...this.sessions.values()])
  }

  private transcript(sessionId: string): TranscriptEntry[] {
    let t = this.transcripts.get(sessionId)
    if (!t) {
      t = store.loadTranscript(sessionId)
      this.transcripts.set(sessionId, t)
    }
    return t
  }

  private touch(session: SessionMeta, patch: Partial<SessionMeta>): void {
    Object.assign(session, patch, { updatedAt: now() })
    this.save()
    this.hub.broadcast({ type: 'session', session })
  }

  private addEntry(sessionId: string, entry: TranscriptEntry): void {
    const t = this.transcript(sessionId)
    t.push(entry)
    store.saveTranscript(sessionId, t)
    this.hub.broadcast({ type: 'entry', sessionId, entry })
  }

  private replaceEntry(sessionId: string, entry: TranscriptEntry): void {
    const t = this.transcript(sessionId)
    const i = t.findIndex((e) => e.id === entry.id)
    if (i >= 0) t[i] = entry
    else t.push(entry)
    store.saveTranscript(sessionId, t)
    this.hub.broadcast({ type: 'entry', sessionId, entry })
  }

  private startLive(session: SessionMeta): LiveSession | null {
    const project = this.projects.get(session.projectId)
    if (!project) {
      this.addEntry(session.id, {
        kind: 'error',
        id: uid(),
        text: 'O projeto desta sessão não está mais registrado. Registre a pasta novamente em Projetos.',
        ts: now(),
      })
      return null
    }
    // se a sessão anterior ainda está drenando, aborta agora para não haver dois
    // processos com o mesmo session_id competindo pelo arquivo de sessão
    const ending = this.ending.get(session.id)
    if (ending) {
      clearTimeout(ending.timer)
      this.ending.delete(session.id)
      ending.live.abort.abort()
    }
    const queue = new AsyncQueue<SDKUserMessage>()
    const abort = new AbortController()
    const mcpServers = loadProjectMcpServers(project.path)
    // memória de fatos + catálogo de documentos do projeto, reinjetados no system prompt
    const projectMemory = renderMemory(session.projectId, session.projectName)
    const docCatalog = renderDocCatalog(session.projectId, session.projectName)
    const appended = [projectMemory, docCatalog].filter(Boolean).join('\n\n---\n\n')
    const q = query({
      prompt: queue,
      options: {
        cwd: project.path,
        ...(session.sdkSessionId ? { resume: session.sdkSessionId } : {}),
        ...(session.model ? { model: session.model } : {}),
        ...(session.effort ? { effort: session.effort as EffortLevel } : {}),
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          ...(appended ? { append: appended } : {}),
        },
        settingSources: ['user', 'project', 'local'],
        ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
        permissionMode: session.permissionMode as PermissionMode,
        // permite ligar o modo "não perguntar" ao vivo via setPermissionMode
        allowDangerouslySkipPermissions: true,
        includePartialMessages: true,
        abortController: abort,
        // garante auth pela assinatura (login do Claude Code), nunca por API key
        env: { ...process.env, ANTHROPIC_API_KEY: undefined },
        stderr: (data: string) => {
          if (process.env.GREED_DEBUG) console.error(`[sdk ${session.id.slice(0, 8)}]`, data)
        },
        canUseTool: (toolName, input, opts) =>
          this.handlePermission(session.id, toolName, input, opts),
        hooks: {
          Stop: [{ hooks: [async () => (this.onTurnStopped(session.id), {})] }],
          SessionEnd: [{ hooks: [async () => (this.onSessionEnded(session.id), {})] }],
        },
      },
    })
    const live: LiveSession = {
      queue,
      q,
      abort,
      pending: new Map(),
      currentAssistantId: null,
      turnSeq: 0,
    }
    this.live.set(session.id, live)
    void this.runLoop(session.id, live)
    return live
  }

  private async runLoop(sessionId: string, live: LiveSession): Promise<void> {
    try {
      for await (const msg of live.q) {
        this.handleMessage(sessionId, live, msg)
      }
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err)
      // só reporta erro se este ainda é o live corrente (não um que foi substituído)
      if (this.live.get(sessionId) === live) {
        this.addEntry(sessionId, {
          kind: 'error',
          id: uid(),
          text: `A sessão encerrou com erro: ${text}`,
          ts: now(),
        })
        const session = this.sessions.get(sessionId)
        if (session) this.touch(session, { lastError: text })
      }
    } finally {
      const isCurrent = this.live.get(sessionId) === live
      this.rejectAllPending(live, 'Sessão encerrada.')
      // limpa registro em qualquer um dos dois mapas onde este live estiver
      const ending = this.ending.get(sessionId)
      if (ending && ending.live === live) {
        clearTimeout(ending.timer)
        this.ending.delete(sessionId)
        this.evictTranscriptIfClosed(sessionId)
      }
      if (isCurrent) {
        this.live.delete(sessionId)
        const session = this.sessions.get(sessionId)
        if (session && session.status !== 'idle') this.touch(session, { status: 'idle' })
      }
    }
  }

  private handleMessage(sessionId: string, live: LiveSession, msg: SDKMessage): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    switch (msg.type) {
      case 'system': {
        if (msg.subtype === 'init' && msg.session_id && msg.session_id !== session.sdkSessionId) {
          this.touch(session, { sdkSessionId: msg.session_id })
        }
        break
      }

      case 'stream_event': {
        if (msg.parent_tool_use_id) break // atividade de subagentes fica fora da UI
        const ev = msg.event
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
          const chunk = ev.delta.text
          if (!live.currentAssistantId) {
            live.currentAssistantId = uid()
            this.addEntry(sessionId, {
              kind: 'assistant',
              id: live.currentAssistantId,
              text: chunk,
              ts: now(),
              streaming: true,
            })
          } else {
            const t = this.transcript(sessionId)
            const cur = t.find((e) => e.id === live.currentAssistantId)
            if (cur && cur.kind === 'assistant') {
              cur.text += chunk
              store.saveTranscript(sessionId, t)
            }
            this.hub.broadcast({
              type: 'delta',
              sessionId,
              entryId: live.currentAssistantId,
              text: chunk,
            })
          }
        }
        break
      }

      case 'assistant': {
        if (msg.parent_tool_use_id) break
        let text = ''
        for (const block of msg.message.content) {
          if (block.type === 'text') text += (text ? '\n\n' : '') + block.text
        }
        if (live.currentAssistantId) {
          const entryId = live.currentAssistantId
          live.currentAssistantId = null
          const t = this.transcript(sessionId)
          const cur = t.find((e) => e.id === entryId)
          const finalText = text || (cur?.kind === 'assistant' ? cur.text : '')
          this.replaceEntry(sessionId, {
            kind: 'assistant',
            id: entryId,
            text: finalText,
            ts: now(),
            streaming: false,
          })
        } else if (text) {
          this.addEntry(sessionId, { kind: 'assistant', id: uid(), text, ts: now() })
        }
        for (const block of msg.message.content) {
          if (block.type === 'tool_use') {
            this.addEntry(sessionId, {
              kind: 'tool',
              id: uid(),
              name: block.name,
              summary: summarizeToolInput(block.name, block.input),
              ts: now(),
            })
          }
        }
        if (msg.error) {
          this.addEntry(sessionId, {
            kind: 'error',
            id: uid(),
            text: `Erro do modelo: ${String(msg.error)}`,
            ts: now(),
          })
        }
        break
      }

      case 'result': {
        live.currentAssistantId = null
        if (msg.subtype !== 'success') {
          const detail =
            'errors' in msg && Array.isArray(msg.errors) && msg.errors.length > 0
              ? msg.errors.join('; ')
              : msg.subtype
          this.addEntry(sessionId, {
            kind: 'error',
            id: uid(),
            text: `Turno terminou com erro (${msg.subtype}): ${detail}`,
            ts: now(),
          })
          this.touch(session, { status: 'idle', attention: 'finished', lastError: detail })
        } else {
          this.touch(session, { status: 'idle', attention: 'finished', lastError: null })
          this.captureMemory(session)
        }
        const t = this.transcript(sessionId)
        const lastAssistant = [...t].reverse().find((e) => e.kind === 'assistant')
        this.hub.broadcast({
          type: 'notify',
          sessionId,
          kind: 'finished',
          title: `${session.projectName} — ${session.title}`,
          body: lastAssistant ? truncate(lastAssistant.text, 140) : 'Turno concluído.',
        })
        if (!session.open) this.endLive(sessionId)
        break
      }

      default:
        break
    }
  }

  private handlePermission(
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
    opts: { signal: AbortSignal },
  ): Promise<PermissionResult> {
    const session = this.sessions.get(sessionId)
    const live = this.live.get(sessionId)
    if (!session || !live) {
      return Promise.resolve({ behavior: 'deny', message: 'Sessão não está ativa no Greed.' })
    }
    const request: PermissionRequest = {
      id: uid(),
      sessionId,
      toolName,
      input,
      summary: summarizeToolInput(toolName, input),
      ts: now(),
    }
    const entryId = uid()
    this.addEntry(sessionId, {
      kind: 'permission',
      id: entryId,
      toolName,
      summary: request.summary,
      decision: null,
      ts: now(),
    })
    return new Promise<PermissionResult>((resolve) => {
      const settle = (result: PermissionResult) => {
        if (!live.pending.has(request.id)) return
        live.pending.delete(request.id)
        const decision = result.behavior === 'allow' ? 'allow' : 'deny'
        this.replaceEntry(sessionId, {
          kind: 'permission',
          id: entryId,
          toolName,
          summary: request.summary,
          decision,
          ts: now(),
        })
        this.hub.broadcast({
          type: 'permission_resolved',
          sessionId,
          requestId: request.id,
          decision,
        })
        const s = this.sessions.get(sessionId)
        // volta a 'working' só quando não há mais nada pendente
        if (s && s.status === 'waiting' && live.pending.size === 0) {
          this.touch(s, { status: 'working', attention: null })
        }
        resolve(result)
      }
      live.pending.set(request.id, { request, resolve: settle })
      opts.signal.addEventListener(
        'abort',
        () => settle({ behavior: 'deny', message: 'Pedido cancelado pela sessão.' }),
        { once: true },
      )
      this.touch(session, { status: 'waiting', attention: 'waiting' })
      this.hub.broadcast({ type: 'permission_request', request })
      this.hub.broadcast({
        type: 'notify',
        sessionId,
        kind: 'waiting',
        title: `${session.projectName} — ${session.title}`,
        body: `Pedindo permissão: ${toolName}`,
      })
    })
  }

  /** Stop hook: rede de segurança caso o result não chegue pelo stream. */
  private onTurnStopped(sessionId: string): void {
    const live = this.live.get(sessionId)
    if (!live) return
    const seq = live.turnSeq
    const timer = setTimeout(() => {
      const session = this.sessions.get(sessionId)
      const cur = this.live.get(sessionId)
      // só aplica se for o mesmo live e o mesmo turno que disparou o Stop
      if (cur === live && cur.turnSeq === seq && session?.status === 'working' && cur.pending.size === 0) {
        this.touch(session, { status: 'idle', attention: 'finished' })
      }
    }, 1500)
    timer.unref()
  }

  private onSessionEnded(sessionId: string): void {
    const live = this.live.get(sessionId)
    if (live && live.pending.size > 0) this.rejectAllPending(live, 'Sessão encerrada.')
  }

  private rejectAllPending(live: LiveSession, reason: string): void {
    // snapshot: settle() muta o Map durante a iteração
    for (const entry of [...live.pending.values()]) {
      entry.resolve({ behavior: 'deny', message: reason })
    }
  }

  private endLive(sessionId: string): void {
    const live = this.live.get(sessionId)
    if (!live) return
    this.live.delete(sessionId)
    this.rejectAllPending(live, 'Sessão fechada.')
    live.queue.end()
    // se o processo não encerrar sozinho depois do fim do input, aborta
    const timer = setTimeout(() => {
      this.ending.delete(sessionId)
      live.abort.abort()
      this.evictTranscriptIfClosed(sessionId)
    }, 5000)
    timer.unref()
    this.ending.set(sessionId, { live, timer })
  }

  /** Ao fim de um turno bem-sucedido, extrai memórias duráveis para o cluster do projeto. */
  private captureMemory(session: SessionMeta): void {
    const t = this.transcript(session.id)
    let ui = -1
    for (let i = t.length - 1; i >= 0; i--) {
      if (t[i].kind === 'user') {
        ui = i
        break
      }
    }
    if (ui < 0) return
    const userEntry = t[ui]
    if (userEntry.kind !== 'user') return
    let assistantText = ''
    for (let i = ui + 1; i < t.length; i++) {
      const e = t[i]
      if (e.kind === 'assistant') assistantText += (assistantText ? '\n' : '') + e.text
    }
    if (!assistantText.trim()) return
    captureTurn({
      projectId: session.projectId,
      projectName: session.projectName,
      sessionId: session.id,
      userText: userEntry.text,
      assistantText,
    })
  }

  /** libera o transcript da memória quando a sessão não está aberta na UI. */
  private evictTranscriptIfClosed(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session && !session.open && !this.live.has(sessionId)) {
      store.flush()
      this.transcripts.delete(sessionId)
    }
  }
}
