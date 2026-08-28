import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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
  ActivityItem,
  ActivityStatus,
  BtwExchange,
  FleetSnapshot,
  MsgAttachment,
  PermissionRequest,
  ServerMsg,
  SessionMeta,
  TranscriptEntry,
} from '../shared/types'
import { askBtw } from './btw'
import { rememberFrom } from './commands'
import { ingestDoc, renderDocCatalog } from './docs'
import { FleetLog } from './fleet'
import type { Hub } from './hub'
import { loadProjectMcpServers } from './mcp'
import { captureTurn, memoryTools, renderMemory } from './memory'
import { envForProfile } from './profiles'
import type { ProjectRegistry } from './projects'
import { findAllFiles, PREVIEW_EXT, PREVIEW_MAX } from './preview'
import { store } from './store'
import { tagAsGreed } from './tags'
import { fallbackTitle, generateTitle } from './titles'
import { now, summarizeToolInput, toolTarget, truncate, uid } from './util'

/** Monta o que o modelo recebe: o texto do usuário + os anexos, nesta ordem. */
function composeForModel(text: string, attachments: MsgAttachment[]): string {
  let out = text
  for (const a of attachments) {
    if (a.content != null) {
      out += `${out ? '\n\n' : ''}----- arquivo anexado: ${a.name} -----\n${a.content}\n----- fim: ${a.name} -----`
    } else if (a.path) {
      out += `${out ? '\n\n' : ''}[arquivo anexado salvo em ${a.path} — abra com Read/Edit]`
    }
  }
  return out
}

const PERM_MODES = new Set(['default', 'acceptEdits', 'bypassPermissions'])
/** teto do nome de um chat renomeado à mão */
const TITLE_MAX = 120
/** quantas perguntas de canto ficam guardadas por sessão */
const BTW_KEEP = 30
/** cache em data/: quais entregáveis saíram de qual chat */
const AUTHORED = 'authored'
/** teto de arquivos lembrados por chat (o preview só mostra 40 mesmo) */
const AUTHORED_KEEP = 200
/** sem turno pra separar (chat antigo), arquivos escritos neste intervalo contam como a mesma leva */
const SAME_BATCH_MS = 10 * 60 * 1000
function normalizePermMode(mode?: string): string {
  return mode && PERM_MODES.has(mode) ? mode : 'default'
}

/** valida a pasta do codebase; retorna caminho absoluto ou null. */
function normalizeCodebase(input?: string | null): string | null {
  if (!input || !input.trim()) return null
  let p = input.trim()
  if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1))
  p = path.resolve(p)
  try {
    return fs.statSync(p).isDirectory() ? p : null
  } catch {
    return null
  }
}

function mtimeOf(file: string): number {
  try {
    return fs.statSync(file).mtimeMs
  } catch {
    return 0
  }
}

/** Mantém só os N mais recentes (a inserção é em ordem, então corta pela frente). */
function trimSet(set: Set<string>, max: number): Set<string> {
  if (set.size <= max) return set
  return new Set([...set].slice(set.size - max))
}

const WRITER_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
/** No shell, só o destino declarado conta: `> arq`, `-o arq`, `tee arq`. */
const SHELL_OUT =
  /(?:>>?|\B-o\s|--output[=\s]|--print-to-pdf=|\btee\s)\s*("[^"]+"|'[^']+'|[^\s;|&"']+)/g

/**
 * Caminhos que uma tool escreveu, lidos do resumo guardado no transcript. Ler um
 * arquivo não é autoria: quem só deu `cat` num .md não fica dono dele.
 */
function writtenPaths(toolName: string, summary: string): string[] {
  const text = summary.replace(/…$/, '')
  if (WRITER_TOOLS.has(toolName)) {
    const m = /^(?:file_path|notebook_path|path):\s*(.+)$/.exec(text)
    return m ? [m[1].trim()] : []
  }
  if (toolName !== 'Bash') return []
  const out: string[] = []
  for (const m of text.matchAll(SHELL_OUT)) {
    const cand = m[1].replace(/^["']|["']$/g, '')
    if (PREVIEW_EXT.test(cand)) out.push(cand)
  }
  return out
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
  /** árvore de atividade viva do turno (tool_use_id / task_id → item), efêmera */
  activity: Map<string, ActivityItem>
}

export class SessionManager {
  private sessions = new Map<string, SessionMeta>()
  private transcripts = new Map<string, TranscriptEntry[]>()
  private live = new Map<string, LiveSession>()
  /** perguntas de canto (/btw) por sessão — vivem só nesta execução do servidor */
  private btw = new Map<string, BtwExchange[]>()
  /** sessões cujo query() foi encerrado mas ainda está drenando (janela de graça antes do abort) */
  private ending = new Map<string, { live: LiveSession; timer: NodeJS.Timeout }>()
  /** diário de bordo da frota: sobrevive ao fim do turno, ao contrário da árvore de atividade */
  private fleet = new FleetLog((msg) => this.hub.broadcast(msg))
  /**
   * Entregáveis de cada chat (caminho absoluto): `files` é tudo que ele já
   * produziu, `last` é a leva do último turno que produziu alguma coisa — é ela
   * que a barra mostra, pra ver o v2 sem o v1 e o v0 junto.
   */
  private authored = new Map<string, { files: Set<string>; last: string[] }>()
  /** início do turno em curso: o que mexer daí pra frente é obra deste chat */
  private turnStart = new Map<string, number>()

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
      s.codebasePath = s.codebasePath ?? null
      s.profile = s.profile ?? null
      this.sessions.set(s.id, s)
    }
    const saved = store.read<Record<string, { files?: string[]; last?: string[] }>>(AUTHORED, {})
    for (const [id, rec] of Object.entries(saved)) {
      if (!this.sessions.has(id) || !Array.isArray(rec?.files)) continue
      this.authored.set(id, {
        files: new Set(rec.files),
        last: Array.isArray(rec.last) ? rec.last : [],
      })
    }
  }

  snapshot(): ServerMsg {
    const sessions = [...this.sessions.values()]
    const transcripts: Record<string, TranscriptEntry[]> = {}
    for (const s of sessions) {
      if (s.open) transcripts[s.id] = this.transcript(s.id)
    }
    const permissions: PermissionRequest[] = []
    const activity: Record<string, ActivityItem[]> = {}
    for (const [id, live] of this.live) {
      for (const p of live.pending.values()) permissions.push(p.request)
      if (live.activity.size > 0) activity[id] = [...live.activity.values()]
    }
    return {
      type: 'snapshot',
      projects: this.projects.list(),
      sessions,
      transcripts,
      permissions,
      activity,
    }
  }

  /** estado da tela de Agentes pra quem acabou de conectar */
  fleetSnapshot(): { type: 'fleet_snapshot'; fleet: FleetSnapshot } {
    return { type: 'fleet_snapshot', fleet: this.fleet.snapshot() }
  }

  /** id de sessão do SDK → o card do Greed, pra dar nome ao consumo dos transcripts */
  cardsBySdkSession(): Map<string, { title: string; projectName: string }> {
    const out = new Map<string, { title: string; projectName: string }>()
    for (const s of this.sessions.values()) {
      if (s.sdkSessionId) out.set(s.sdkSessionId, { title: s.title, projectName: s.projectName })
    }
    return out
  }

  createSession(
    projectId: string,
    prompt: string,
    model?: string | null,
    effort?: string | null,
    permissionMode?: string,
    codebasePath?: string | null,
    profile?: string | null,
    attachments: MsgAttachment[] = [],
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
      codebasePath: normalizeCodebase(codebasePath),
      profile: profile && profile.trim() ? profile.trim() : null,
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
    this.sendUserMessage(session.id, prompt, attachments)
    void generateTitle(prompt).then((title) => {
      if (!title) return
      const s = this.sessions.get(session.id)
      // se o usuário já renomeou na mão enquanto o modelo pensava, o dele vale
      if (s && s.title === session.title) this.touch(s, { title })
    })
    return session
  }

  importSession(opts: {
    projectId: string
    threadId: string
    profile: string | null
    cwd: string
    title: string
    entries: TranscriptEntry[]
  }): SessionMeta {
    const project = this.projects.get(opts.projectId)
    if (!project) throw new Error('Projeto não encontrado')
    const session: SessionMeta = {
      id: uid(),
      projectId: opts.projectId,
      projectName: project.name,
      title: opts.title.trim().slice(0, TITLE_MAX) || 'Thread importada',
      sdkSessionId: opts.threadId,
      model: null,
      effort: null,
      permissionMode: 'bypassPermissions',
      codebasePath: normalizeCodebase(opts.cwd),
      profile: opts.profile,
      open: true,
      status: 'idle',
      attention: null,
      createdAt: now(),
      updatedAt: now(),
      lastError: null,
    }
    this.sessions.set(session.id, session)
    this.transcripts.set(session.id, opts.entries)
    store.saveTranscript(session.id, opts.entries)
    this.save()
    this.hub.broadcast({ type: 'session', session })
    this.hub.broadcast({ type: 'transcript', sessionId: session.id, entries: opts.entries })
    return session
  }

  sendUserMessage(sessionId: string, text: string, attachments: MsgAttachment[] = []): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    const clean = text.trim()
    if (!clean && attachments.length === 0) return
    // o balão guarda só o que você escreveu; o conteúdo do anexo vai pro modelo
    this.addEntry(sessionId, {
      kind: 'user',
      id: uid(),
      text: clean,
      ts: now(),
      ...(attachments.length > 0
        ? {
            attachments: attachments.map((a) => ({
              name: a.name,
              kind: a.content != null ? ('inline' as const) : ('file' as const),
            })),
          }
        : {}),
    })
    const forModel = composeForModel(clean, attachments)
    const existing = this.live.get(sessionId)
    if (existing) this.clearActivity(sessionId, existing) // árvore limpa no novo turno
    this.fleet.startRun(sessionId) // o log da frota, ao contrário, começa um capítulo novo
    const live = existing ?? this.startLive(session)
    if (!live) return
    live.turnSeq += 1
    this.turnStart.set(sessionId, now())
    live.queue.push({
      type: 'user',
      message: { role: 'user', content: forModel },
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

  /** /btw: pergunta paralela, em processo próprio — o turno em andamento nem sente. */
  askBtw(sessionId: string, text: string): void {
    const session = this.sessions.get(sessionId)
    const cwd = this.previewRootForSession(sessionId)
    const question = text.trim()
    if (!session || !cwd || !question) return

    const exchange: BtwExchange = {
      id: uid(),
      sessionId,
      question,
      answer: '',
      status: 'asking',
      ts: now(),
    }
    const history = this.btw.get(sessionId) ?? []
    history.push(exchange)
    this.btw.set(sessionId, history.slice(-BTW_KEEP))
    this.hub.broadcast({ type: 'btw', exchange })

    void askBtw(session, cwd, this.transcript(sessionId), history.slice(0, -1), question)
      .then((answer) => {
        exchange.answer = answer
        exchange.status = 'done'
      })
      .catch((err: unknown) => {
        exchange.answer = err instanceof Error ? err.message : String(err)
        exchange.status = 'error'
      })
      .finally(() => this.hub.broadcast({ type: 'btw', exchange }))
  }

  /** linha discreta no transcript: a base de conhecimento do projeto mudou. */
  private noteMemory(sessionId: string, text: string, source: 'doc' | 'facts'): void {
    if (!this.sessions.has(sessionId)) return
    this.addEntry(sessionId, { kind: 'memory', id: uid(), text, source, ts: now() })
  }

  btwHistory(sessionId: string): BtwExchange[] {
    return this.btw.get(sessionId) ?? []
  }

  /** cwd da sessão: a pasta onde o agente roda (codebase ou projeto). */
  previewRootForSession(sessionId: string): string | null {
    const session = this.sessions.get(sessionId)
    if (!session) return null
    return session.codebasePath ?? this.projects.get(session.projectId)?.path ?? null
  }

  /**
   * Pastas que o preview varre. Com codebase o cwd é o repo, mas a pasta do
   * projeto vai junto em additionalDirectories — e é lá que ele costuma largar
   * o entregável (pdf, html). Varrer só o cwd sumia com esses arquivos.
   * A ordem é estável: o índice vira o `root` da URL do preview.
   */
  previewRootsForSession(sessionId: string): string[] {
    const session = this.sessions.get(sessionId)
    if (!session) return []
    const projectPath = this.projects.get(session.projectId)?.path ?? null
    const roots = [session.codebasePath, projectPath]
      .filter((p): p is string => typeof p === 'string' && p.length > 0)
      .map((p) => path.resolve(p))
    // uma pasta dentro da outra já é varrida pela de fora: não repete
    return roots.filter(
      (p, i) => roots.indexOf(p) === i && !roots.slice(0, i).some((o) => p.startsWith(o + path.sep)),
    )
  }

  /**
   * Entregáveis deste chat, mais recente primeiro. A pasta é do projeto e vários
   * chats dividem ela — sem este filtro o mesmo .md aparecia na barra de todos.
   * `last` marca a leva do último turno que produziu algo: é o que a barra
   * mostra por padrão, pra ver o v2 sem o v1 e o v0 do lado.
   */
  previewFilesForSession(
    sessionId: string,
  ): { rel: string; mtime: number; root: number; last: boolean }[] {
    const roots = this.previewRootsForSession(sessionId)
    if (roots.length === 0) return []
    const mine = this.authoredFor(sessionId)
    const last = new Set(mine.last)
    return findAllFiles(roots)
      .filter((f) => f.abs && mine.files.has(f.abs))
      .slice(0, PREVIEW_MAX)
      .map(({ rel, mtime, root, abs }) => ({ rel, mtime, root, last: last.has(abs as string) }))
  }

  /**
   * Fecha o turno anotando o que mudou nas pastas da sessão desde que ele
   * começou. É por mtime, não por tool: pega tanto o Write quanto o pdf que
   * saiu de um script no Bash, que é como a maioria dos entregáveis nasce.
   */
  private recordAuthored(sessionId: string): void {
    const since = this.turnStart.get(sessionId)
    this.turnStart.delete(sessionId)
    if (!since) return
    const roots = this.previewRootsForSession(sessionId)
    if (roots.length === 0) return
    const mine = this.authoredFor(sessionId)
    const batch = findAllFiles(roots)
      .filter((f) => f.abs && f.mtime >= since)
      .map((f) => f.abs as string)
    // turno sem entregável (uma pergunta, um ajuste no código) não apaga a leva
    // anterior da barra: o que ele fez no turno passado continua à mão
    if (batch.length === 0) return
    for (const abs of batch) mine.files.add(abs)
    this.authored.set(sessionId, {
      files: trimSet(mine.files, AUTHORED_KEEP),
      last: batch.slice(0, PREVIEW_MAX),
    })
    this.saveAuthored()
    void tagAsGreed(batch).catch(() => {}) // etiqueta é enfeite: não derruba o turno
  }

  /** Lista do chat, com a primeira leitura reconstruída do transcript. */
  private authoredFor(sessionId: string): { files: Set<string>; last: string[] } {
    const known = this.authored.get(sessionId)
    if (known) return known
    const seeded = this.authoredFromTranscript(sessionId)
    this.authored.set(sessionId, seeded)
    return seeded
  }

  /**
   * Chats de antes desta anotação não têm histórico de turno, então a lista sai
   * do transcript: caminho de Write/Edit e o destino dos comandos que gravam.
   * Sem turno pra separar as levas, `last` vira o que saiu junto do arquivo mais
   * novo — na prática, a última leva.
   */
  private authoredFromTranscript(sessionId: string): { files: Set<string>; last: string[] } {
    const roots = this.previewRootsForSession(sessionId)
    const files = new Set<string>()
    for (const e of this.transcript(sessionId)) {
      if (e.kind !== 'tool' || !e.summary) continue
      for (const cand of writtenPaths(e.name, e.summary)) {
        for (const root of roots) {
          const abs = path.resolve(root, cand)
          if (!abs.startsWith(root + path.sep)) continue
          if (fs.existsSync(abs)) files.add(abs)
        }
      }
    }
    const times = [...files]
      .map((abs) => ({ abs, mtime: mtimeOf(abs) }))
      .sort((a, b) => b.mtime - a.mtime)
    const newest = times[0]?.mtime ?? 0
    return {
      files,
      last: times.filter((f) => newest - f.mtime <= SAME_BATCH_MS).map((f) => f.abs),
    }
  }

  private saveAuthored(): void {
    const out: Record<string, { files: string[]; last: string[] }> = {}
    for (const [id, rec] of this.authored) {
      if (rec.files.size > 0 && this.sessions.has(id)) {
        out[id] = { files: [...rec.files], last: rec.last }
      }
    }
    store.write(AUTHORED, out)
  }

  /** ingesta um anexo salvo na base de conhecimento do projeto (extrai texto + indexa). */
  ingestAttachment(sessionId: string, name: string, relPath: string, bytes: Buffer): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.ingestProjectAttachment(session.projectId, name, relPath, bytes, sessionId)
  }

  /** mesma ingestão, sem sessão: anexo colado no modal antes do chat existir. */
  ingestProjectAttachment(
    projectId: string,
    name: string,
    relPath: string,
    bytes: Buffer,
    sessionId = '',
  ): void {
    const project = this.projects.get(projectId)
    if (!project) return
    ingestDoc({
      projectId,
      projectName: project.name,
      projectPath: project.path,
      sessionId,
      name,
      relPath,
      bytes,
      onSaved: ({ name: docName, ok }) =>
        this.noteMemory(
          sessionId,
          ok ? `${docName} indexado na base do projeto` : `${docName} salvo (sem texto extraído)`,
          'doc',
        ),
    })
  }

  /** renomeia o chat; vazio é ignorado pra não deixar card sem nome */
  renameSession(sessionId: string, title: string): void {
    const session = this.sessions.get(sessionId)
    const clean = title.trim().slice(0, TITLE_MAX)
    if (!session || !clean || session.title === clean) return
    this.touch(session, { title: clean })
  }

  /** projeto renomeado: os chats guardam o nome junto, então acompanham */
  renameProject(projectId: string, name: string): void {
    for (const session of this.sessions.values()) {
      if (session.projectId === projectId && session.projectName !== name) {
        this.touch(session, { projectName: name })
      }
    }
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

  /**
   * Troca a conta (CLAUDE_CONFIG_DIR) de uma sessão. Env só muda no spawn, então
   * o processo vivo é encerrado de leve e o próximo turno renasce com o novo env,
   * retomando o contexto pelo resume. Com turno rodando (ou permissão pendente)
   * a troca é recusada — a UI desabilita o seletor nesses estados.
   */
  setProfile(sessionId: string, profile: string | null): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    const next = profile && profile.trim() ? profile.trim() : null
    if (session.profile === next) return
    const live = this.live.get(sessionId)
    if (live && (session.status !== 'idle' || live.pending.size > 0)) return
    this.touch(session, { profile: next })
    if (live) this.endLive(sessionId)
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

  deleteSession(sessionId: string): void {
    if (!this.sessions.has(sessionId)) return
    const live = this.live.get(sessionId)
    if (live) {
      this.rejectAllPending(live, 'Chat apagado.')
      this.live.delete(sessionId)
      live.queue.end()
      live.abort.abort()
    }
    const ending = this.ending.get(sessionId)
    if (ending) {
      clearTimeout(ending.timer)
      ending.live.abort.abort()
      this.ending.delete(sessionId)
    }
    this.fleet.dropSession(sessionId)
    this.btw.delete(sessionId)
    this.sessions.delete(sessionId)
    this.transcripts.delete(sessionId)
    this.turnStart.delete(sessionId)
    if (this.authored.delete(sessionId)) this.saveAuthored()
    store.deleteTranscript(sessionId)
    this.save()
    this.hub.broadcast({ type: 'session_gone', sessionId })
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

  // ── atividade viva do turno (efêmera, não persiste) ─────────────────────

  private pushActivity(sessionId: string, live: LiveSession, item: ActivityItem): void {
    live.activity.set(item.id, item)
    this.hub.broadcast({ type: 'activity', sessionId, item })
    this.fleet.track(sessionId, item)
  }

  private updateActivity(
    sessionId: string,
    live: LiveSession,
    id: string,
    patch: Partial<ActivityItem>,
  ): void {
    const cur = live.activity.get(id)
    const item: ActivityItem = cur
      ? { ...cur, ...patch, updatedAt: now() }
      : {
          id,
          parentId: null,
          kind: 'tool',
          // o evento que criou este item chegou sem nome (ex.: progresso de algo que
          // começou antes); id cru na tela não diz nada a ninguém
          name: patch.name ?? 'trabalho',
          detail: '',
          status: 'running',
          ts: now(),
          updatedAt: now(),
          ...patch,
        }
    live.activity.set(id, item)
    this.hub.broadcast({ type: 'activity', sessionId, item })
    this.fleet.track(sessionId, item)
  }

  private clearActivity(sessionId: string, live: LiveSession): void {
    if (live.activity.size === 0) return
    live.activity.clear()
    this.hub.broadcast({ type: 'activity_clear', sessionId })
  }

  private reconcileBackground(
    sessionId: string,
    live: LiveSession,
    tasks: { task_id: string; task_type?: string; description?: string }[],
  ): void {
    const alive = new Set(tasks.map((t) => t.task_id))
    for (const [id, it] of live.activity) {
      if (it.kind === 'task' && !alive.has(id) && it.status === 'running') {
        this.updateActivity(sessionId, live, id, { status: 'done' })
      }
    }
    for (const t of tasks) {
      this.updateActivity(sessionId, live, t.task_id, {
        kind: 'task',
        name: t.task_type ?? 'task',
        detail: t.description ?? '',
        background: true,
        status: 'running',
      })
    }
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
    // cwd = codebase (onde o agente edita/commita) ou a própria pasta do projeto
    const cwd = session.codebasePath ?? project.path
    const mcpServers = {
      ...(session.codebasePath
        ? { ...loadProjectMcpServers(project.path), ...loadProjectMcpServers(session.codebasePath) }
        : loadProjectMcpServers(project.path)),
      // recall/zoom sobre a memória OptMem do projeto: o contexto injetado é uma
      // cobertura comprimida, e estas tools são como o agente desce no detalhe
      greed_memory: memoryTools(session.projectId),
    }
    // memória de fatos + catálogo de documentos do projeto, reinjetados no system prompt
    const projectMemory = renderMemory(session.projectId, session.projectName)
    const docCatalog = renderDocCatalog(session.projectId, session.projectName, project.path)
    // com codebase, o cwd é outro, então o CLAUDE.md do projeto (contexto) não carrega
    // nativo — injeta o conteúdo dele à mão
    let projectContext: string | null = null
    if (session.codebasePath) {
      try {
        const md = fs.readFileSync(path.join(project.path, 'CLAUDE.md'), 'utf8').trim()
        if (md) projectContext = `# Contexto do projeto "${session.projectName}" (CLAUDE.md)\n\n${md}`
      } catch {
        // projeto sem CLAUDE.md — sem contexto extra
      }
    }
    const appended = [projectContext, projectMemory, docCatalog]
      .filter(Boolean)
      .join('\n\n---\n\n')
    const q = query({
      prompt: queue,
      options: {
        cwd,
        ...(session.codebasePath ? { additionalDirectories: [project.path] } : {}),
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
        // resumo humano do que cada subagente está fazendo (custo mínimo)
        agentProgressSummaries: true,
        abortController: abort,
        env: envForProfile(session.profile),
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
      activity: new Map(),
    }
    this.live.set(session.id, live)
    // aproveita a sessão viva pra manter a lista de comandos desta pasta em dia
    rememberFrom(cwd, q)
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
        // um query que morre sem `result` deixaria o turno aberto pra sempre no log
        this.fleet.dropSession(sessionId)
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
        const m = msg as unknown as {
          subtype: string
          session_id?: string
          task_id?: string
          tool_use_id?: string
          subagent_type?: string
          workflow_name?: string
          task_type?: string
          description?: string
          summary?: string
          last_tool_name?: string
          status?: string
          usage?: { total_tokens?: number; tool_uses?: number; duration_ms?: number }
          patch?: { status?: string; is_backgrounded?: boolean; description?: string }
          tasks?: { task_id: string; task_type?: string; description?: string }[]
        }
        switch (m.subtype) {
          case 'init':
            if (m.session_id && m.session_id !== session.sdkSessionId) {
              this.touch(session, { sdkSessionId: m.session_id })
            }
            break
          case 'task_started':
            if (m.task_id) {
              this.pushActivity(sessionId, live, {
                id: m.task_id,
                parentId: m.tool_use_id ?? null,
                kind: m.subagent_type ? 'subagent' : 'task',
                name: m.subagent_type ?? m.workflow_name ?? m.task_type ?? 'task',
                detail: m.description ?? '',
                status: 'running',
                ts: now(),
                updatedAt: now(),
              })
            }
            break
          case 'task_progress':
            if (m.task_id) {
              this.updateActivity(sessionId, live, m.task_id, {
                kind: m.subagent_type ? 'subagent' : 'task',
                ...(m.tool_use_id ? { parentId: m.tool_use_id } : {}),
                status: 'running',
                detail: m.summary ?? m.description ?? '',
                ...(m.subagent_type ? { name: m.subagent_type } : {}),
                ...(m.last_tool_name ? { tool: m.last_tool_name } : {}),
                ...(m.usage?.total_tokens != null ? { tokens: m.usage.total_tokens } : {}),
                ...(m.usage?.tool_uses != null ? { toolUses: m.usage.tool_uses } : {}),
                ...(m.usage?.duration_ms != null ? { elapsedMs: m.usage.duration_ms } : {}),
              })
            }
            break
          case 'task_updated':
            if (m.task_id && m.patch) {
              const st = m.patch.status
              const mapped: ActivityStatus | undefined = st
                ? st === 'running' || st === 'pending'
                  ? 'running'
                  : st === 'completed'
                    ? 'done'
                    : 'error'
                : undefined
              this.updateActivity(sessionId, live, m.task_id, {
                ...(mapped ? { status: mapped } : {}),
                ...(m.patch.is_backgrounded != null ? { background: m.patch.is_backgrounded } : {}),
                ...(m.patch.description ? { detail: m.patch.description } : {}),
              })
            }
            break
          case 'task_notification':
            if (m.task_id) {
              this.updateActivity(sessionId, live, m.task_id, {
                status: m.status === 'completed' ? 'done' : 'error',
                ...(m.summary ? { detail: m.summary } : {}),
                ...(m.usage?.total_tokens != null ? { tokens: m.usage.total_tokens } : {}),
              })
            }
            break
          case 'background_tasks_changed':
            if (m.tasks) this.reconcileBackground(sessionId, live, m.tasks)
            break
        }
        break
      }

      case 'tool_progress': {
        const m = msg as unknown as {
          tool_use_id: string
          tool_name?: string
          parent_tool_use_id?: string | null
          elapsed_time_seconds?: number
          subagent_type?: string
        }
        this.updateActivity(sessionId, live, m.tool_use_id, {
          status: 'running',
          ...(m.tool_name ? { name: m.tool_name } : {}),
          parentId: m.parent_tool_use_id ?? null,
          ...(m.elapsed_time_seconds != null
            ? { elapsedMs: Math.round(m.elapsed_time_seconds * 1000) }
            : {}),
          ...(m.subagent_type ? { kind: 'subagent' as const } : {}),
        })
        break
      }

      case 'user': {
        const content = (msg as { message: { content: unknown } }).message.content
        if (!Array.isArray(content)) break // string = prompt do próprio usuário, ignora
        for (const block of content) {
          const b = block as {
            type?: string
            tool_use_id?: string
            content?: unknown
            is_error?: boolean
          }
          if (b.type !== 'tool_result' || !b.tool_use_id) continue
          const isErr = b.is_error === true
          const preview = truncate(
            typeof b.content === 'string' ? b.content : JSON.stringify(b.content),
            200,
          )
          const t = this.transcript(sessionId)
          const cur = t.find((e) => e.id === b.tool_use_id)
          if (cur && cur.kind === 'tool') {
            this.replaceEntry(sessionId, {
              ...cur,
              status: isErr ? 'error' : 'done',
              result: preview,
              ts: now(),
            })
          }
          this.updateActivity(sessionId, live, b.tool_use_id, {
            status: isErr ? 'error' : 'done',
            detail: preview,
          })
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
        // mensagem de subagente: o texto dele não vai pro transcript, mas as tools
        // que ele chama alimentam a árvore de atividade e a tela de Agentes
        const nested = Boolean(msg.parent_tool_use_id)
        if (!nested) {
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
        }
        for (const block of msg.message.content) {
          if (block.type === 'tool_use') {
            const summary = summarizeToolInput(block.name, block.input)
            // tools de topo entram no log; subagentes só na árvore de atividade
            if (!nested) {
              this.addEntry(sessionId, {
                kind: 'tool',
                id: block.id, // mantém o id do bloco p/ correlacionar o tool_result
                name: block.name,
                summary,
                status: 'running',
                ts: now(),
              })
            }
            const target = toolTarget(block.input)
            this.pushActivity(sessionId, live, {
              id: block.id,
              parentId: msg.parent_tool_use_id ?? null,
              kind: 'tool',
              name: block.name,
              detail: summary,
              status: 'running',
              ...(target ? { target } : {}),
              ts: now(),
              updatedAt: now(),
            })
          }
        }
        if (msg.error && !nested) {
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
        // segurança: tools que não receberam tool_result viram "done"
        for (const e of [...this.transcript(sessionId)]) {
          if (e.kind === 'tool' && e.status === 'running') {
            this.replaceEntry(sessionId, { ...e, status: 'done', ts: now() })
          }
        }
        this.clearActivity(sessionId, live)
        this.recordAuthored(sessionId)
        this.fleet.endRun(sessionId, msg.subtype === 'success' ? 'ok' : 'error')
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
    // ler a própria memória do projeto não é uma ação que valha um pedido de
    // permissão: é local, somente leitura, e é o Greed lendo o que ele mesmo
    // escreveu. Perguntar aqui só treinaria o usuário a clicar "permitir".
    if (toolName.startsWith('mcp__greed_memory__')) {
      return Promise.resolve({ behavior: 'allow', updatedInput: input })
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
      onSaved: (count) =>
        this.noteMemory(
          session.id,
          `${count} fato${count > 1 ? 's' : ''} novo${count > 1 ? 's' : ''} na memória do projeto`,
          'facts',
        ),
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
