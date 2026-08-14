import {
  query,
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
import type { Hub } from './hub'
import { loadProjectMcpServers } from './mcp'
import type { ProjectRegistry } from './projects'
import { store } from './store'
import { fallbackTitle, generateTitle } from './titles'
import { now, summarizeToolInput, truncate, uid } from './util'

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

interface LiveSession {
  queue: AsyncQueue<SDKUserMessage>
  q: Query
  abort: AbortController
  pending: { request: PermissionRequest; resolve: (r: PermissionResult) => void } | null
  currentAssistantId: string | null
}

export class SessionManager {
  private sessions = new Map<string, SessionMeta>()
  private transcripts = new Map<string, TranscriptEntry[]>()
  private live = new Map<string, LiveSession>()

  constructor(
    private hub: Hub,
    private projects: ProjectRegistry,
  ) {
    for (const s of store.loadSessions()) {
      // o servidor acabou de subir: nada está rodando
      s.status = 'idle'
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
      if (live.pending) permissions.push(live.pending.request)
    }
    return { type: 'snapshot', projects: this.projects.list(), sessions, transcripts, permissions }
  }

  createSession(projectId: string, prompt: string): SessionMeta {
    const project = this.projects.get(projectId)
    if (!project) throw new Error('Projeto não encontrado')
    const session: SessionMeta = {
      id: uid(),
      projectId,
      projectName: project.name,
      title: fallbackTitle(prompt),
      sdkSessionId: null,
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
    live.queue.push({
      type: 'user',
      message: { role: 'user', content: clean },
      parent_tool_use_id: null,
    })
    this.touch(session, { status: 'working', attention: null, lastError: null })
  }

  respondPermission(sessionId: string, requestId: string, behavior: 'allow' | 'deny'): void {
    const live = this.live.get(sessionId)
    if (!live?.pending || live.pending.request.id !== requestId) return
    const input = live.pending.request.input
    if (behavior === 'allow') {
      live.pending.resolve({ behavior: 'allow', updatedInput: input as Record<string, unknown> })
    } else {
      live.pending.resolve({ behavior: 'deny', message: 'O usuário negou a permissão no Bento.' })
    }
  }

  interrupt(sessionId: string): void {
    const live = this.live.get(sessionId)
    if (!live) return
    live.pending?.resolve({ behavior: 'deny', message: 'Interrompido pelo usuário.' })
    void live.q.interrupt().catch(() => {})
  }

  markRead(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session && session.attention) this.touch(session, { attention: null })
  }

  closeCard(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.touch(session, { open: false, attention: null })
    const live = this.live.get(sessionId)
    // trabalhando ou aguardando permissão: continua em background; encerra no fim do turno
    if (live && session.status === 'idle' && !live.pending) this.endLive(sessionId)
  }

  reopenCard(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.touch(session, { open: true })
    this.hub.broadcast({ type: 'transcript', sessionId, entries: this.transcript(sessionId) })
    const live = this.live.get(sessionId)
    if (live?.pending) {
      this.hub.broadcast({ type: 'permission_request', request: live.pending.request })
    }
  }

  shutdown(): void {
    for (const [sessionId, live] of this.live) {
      this.rejectPending(live, 'Servidor encerrando.')
      live.queue.end()
      live.abort.abort()
      this.live.delete(sessionId)
    }
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
    const queue = new AsyncQueue<SDKUserMessage>()
    const abort = new AbortController()
    const mcpServers = loadProjectMcpServers(project.path)
    const q = query({
      prompt: queue,
      options: {
        cwd: project.path,
        ...(session.sdkSessionId ? { resume: session.sdkSessionId } : {}),
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        settingSources: ['user', 'project', 'local'],
        ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
        permissionMode: 'default',
        includePartialMessages: true,
        abortController: abort,
        // garante auth pela assinatura (login do Claude Code), nunca por API key
        env: { ...process.env, ANTHROPIC_API_KEY: undefined },
        stderr: (data: string) => {
          if (process.env.BENTO_DEBUG) console.error(`[sdk ${session.id.slice(0, 8)}]`, data)
        },
        canUseTool: (toolName, input, opts) =>
          this.handlePermission(session.id, toolName, input, opts),
        hooks: {
          Stop: [{ hooks: [async () => (this.onTurnStopped(session.id), {})] }],
          SessionEnd: [{ hooks: [async () => (this.onSessionEnded(session.id), {})] }],
        },
      },
    })
    const live: LiveSession = { queue, q, abort, pending: null, currentAssistantId: null }
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
      this.addEntry(sessionId, {
        kind: 'error',
        id: uid(),
        text: `A sessão encerrou com erro: ${text}`,
        ts: now(),
      })
      const session = this.sessions.get(sessionId)
      if (session) this.touch(session, { lastError: text })
    } finally {
      this.rejectPending(live, 'Sessão encerrada.')
      if (this.live.get(sessionId) === live) this.live.delete(sessionId)
      const session = this.sessions.get(sessionId)
      if (session && session.status !== 'idle') this.touch(session, { status: 'idle' })
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
      return Promise.resolve({ behavior: 'deny', message: 'Sessão não está ativa no Bento.' })
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
      live.pending = {
        request,
        resolve: (result) => {
          live.pending = null
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
          if (s && s.status === 'waiting') this.touch(s, { status: 'working', attention: null })
          resolve(result)
        },
      }
      opts.signal.addEventListener(
        'abort',
        () => {
          if (live.pending?.request.id === request.id) {
            live.pending.resolve({ behavior: 'deny', message: 'Pedido cancelado pela sessão.' })
          }
        },
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
    const timer = setTimeout(() => {
      const session = this.sessions.get(sessionId)
      const live = this.live.get(sessionId)
      if (session && session.status === 'working' && !live?.pending) {
        this.touch(session, { status: 'idle', attention: 'finished' })
      }
    }, 1500)
    timer.unref()
  }

  private onSessionEnded(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session && session.status === 'waiting') {
      const live = this.live.get(sessionId)
      if (live) this.rejectPending(live, 'Sessão encerrada.')
    }
  }

  private rejectPending(live: LiveSession, reason: string): void {
    live.pending?.resolve({ behavior: 'deny', message: reason })
  }

  private endLive(sessionId: string): void {
    const live = this.live.get(sessionId)
    if (!live) return
    this.live.delete(sessionId)
    this.rejectPending(live, 'Sessão fechada.')
    live.queue.end()
    // se o processo não encerrar sozinho depois do fim do input, aborta
    const timer = setTimeout(() => live.abort.abort(), 5000)
    timer.unref()
  }
}
