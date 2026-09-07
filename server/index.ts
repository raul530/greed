import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { WebSocketServer } from 'ws'
import type { MsgAttachment, UsageSnapshot } from '../shared/types'
import { commandsFor } from './commands'
import { Hub } from './hub'
import { buildInsights } from './insights'
import { SessionManager } from './manager'
import { warmMemory } from './memory'
import { createHostGuard } from './net'
import { defaultProfileDir, listProfiles } from './profiles'
import { describeThread, findThreadFile, listThreads, readThreadEntries } from './threads'
import { ProjectRegistry } from './projects'
import { store } from './store'
import { fetchUsage, lastKnownUsage, POLL_MS, startUsagePoller } from './usage'

const PORT = Number(process.env.GREED_PORT ?? 4517)

// Host e Origin contra a lista de nomes permitidos — bloqueia DNS rebinding e
// hijacking cross-site do WebSocket. O casamento em si vive em net.ts; fora do
// loopback (GREED_HOST) os dois cabeçalhos passam a ser obrigatórios.
const guard = createHostGuard({
  bindHost: process.env.GREED_HOST,
  allowedHosts: process.env.GREED_ALLOWED_HOSTS,
})

const app = express()
app.use(express.json({ limit: '2mb' }))
app.use((req, res, next) => {
  if (!guard.allowsHost(req.headers.host)) {
    res.status(403).json({ error: 'Host não permitido' })
    return
  }
  next()
})

const projects = new ProjectRegistry()
const server = http.createServer(app)
const wss = new WebSocketServer({
  server,
  path: '/ws',
  verifyClient: (info, cb) => {
    if (guard.allowsOrigin(info.origin)) cb(true)
    else cb(false, 403, 'Origin não permitida')
  },
})
const hub = new Hub(wss)
const manager = new SessionManager(hub, projects)

// Consumo da assinatura: o poller lê de tempos em tempos e empurra por WS.
let lastUsage: { type: 'usage'; usage: UsageSnapshot | null; error: string | null } | null = null
const usagePoller = startUsagePoller(
  (usage, error) => {
    lastUsage = { type: 'usage', usage, error }
    hub.broadcast(lastUsage)
  },
  () => hub.clientCount() > 0,
)

hub.onConnect((ws) => {
  hub.sendTo(ws, manager.snapshot())
  hub.sendTo(ws, manager.fleetSnapshot())
  // manda o que já temos pra tela não abrir vazia, e relê se estiver velho
  if (lastUsage) hub.sendTo(ws, lastUsage)
  if (!lastUsage?.usage || Date.now() - lastUsage.usage.fetchedAt > POLL_MS) usagePoller.poke()
})
hub.onMessage((msg) => {
  switch (msg.type) {
    case 'user_message':
      manager.sendUserMessage(msg.sessionId, msg.text, msg.attachments)
      break
    case 'btw':
      manager.askBtw(msg.sessionId, msg.text)
      break
    case 'permission_response':
      manager.respondPermission(msg.sessionId, msg.requestId, msg.behavior)
      break
    case 'interrupt':
      manager.interrupt(msg.sessionId)
      break
    case 'mark_read':
      manager.markRead(msg.sessionId)
      break
    case 'set_title':
      manager.renameSession(msg.sessionId, msg.title)
      break
    case 'set_model':
      manager.setModel(msg.sessionId, msg.model)
      break
    case 'set_effort':
      manager.setEffort(msg.sessionId, msg.effort)
      break
    case 'set_permission_mode':
      manager.setPermissionMode(msg.sessionId, msg.mode)
      break
    case 'set_profile':
      manager.setProfile(msg.sessionId, msg.profile)
      break
  }
})

app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})

// De onde saiu o consumo: lê os transcripts locais e devolve os rankings.
// Leitura é cacheada por mtime, então só arquivo mexido é reprocessado.
app.get('/api/insights', async (req, res) => {
  try {
    const hours = Math.min(168, Math.max(1, Number(req.query.hours ?? 24) || 24))
    const report = await buildInsights(manager.cardsBySdkSession(), hours * 60 * 60 * 1000)
    res.json(report)
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// leitura sob demanda (botão "Atualizar"), fora do ritmo do poller
app.get('/api/usage', async (req, res) => {
  const raw = req.query.profile ? String(req.query.profile) : null
  const profile = raw && listProfiles().some((p) => p.dir === raw) ? raw : null
  try {
    const usage = await fetchUsage(profile)
    if (!profile) {
      lastUsage = { type: 'usage', usage, error: null }
      hub.broadcast(lastUsage)
    }
    res.json(usage)
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    // taxa travada com leitura antiga na mão: devolve a antiga em vez de esvaziar a tela
    const known = lastKnownUsage(profile)
    if (known) {
      res.json(known)
      return
    }
    if (!profile) {
      lastUsage = { type: 'usage', usage: null, error }
      hub.broadcast(lastUsage)
    }
    res.status(502).json({ error })
  }
})

// Navegador de pastas (só dentro do home) para escolher a pasta/repo de um projeto.
app.get('/api/browse', (req, res) => {
  try {
    const home = os.homedir()
    let dir = req.query.path ? String(req.query.path) : home
    if (dir === '~' || dir.startsWith('~/')) dir = path.join(home, dir.slice(1))
    dir = path.resolve(dir)
    if (dir !== home && !dir.startsWith(home + path.sep)) dir = home
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => ({ name: e.name, isRepo: fs.existsSync(path.join(dir, e.name, '.git')) }))
      .sort((a, b) => a.name.localeCompare(b.name))
    res.json({
      path: dir,
      parent: dir === home ? null : path.dirname(dir),
      isRepo: fs.existsSync(path.join(dir, '.git')),
      entries,
    })
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

app.post('/api/projects', (req, res) => {
  try {
    const { name, path: dir } = (req.body ?? {}) as { name?: string; path?: string }
    const project = projects.add(String(name ?? ''), String(dir ?? ''))
    hub.broadcast({ type: 'projects', projects: projects.list() })
    res.json(project)
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

app.patch('/api/projects/:id', (req, res) => {
  try {
    const { name } = (req.body ?? {}) as { name?: string }
    const project = projects.rename(req.params.id, String(name ?? ''))
    manager.renameProject(project.id, project.name)
    hub.broadcast({ type: 'projects', projects: projects.list() })
    res.json(project)
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

app.delete('/api/projects/:id', (req, res) => {
  projects.remove(req.params.id)
  hub.broadcast({ type: 'projects', projects: projects.list() })
  res.json({ ok: true })
})

app.get('/api/profiles', (_req, res) => {
  res.json({ profiles: listProfiles(), default: defaultProfileDir() })
})

app.get('/api/threads', (req, res) => {
  const raw = req.query.profile ? String(req.query.profile) : null
  const profile = raw && listProfiles().some((p) => p.dir === raw) ? raw : null
  const limit = Math.min(Math.max(Number(req.query.limit) || 40, 1), 200)
  res.json({ threads: listThreads(profile, limit) })
})

app.post('/api/sessions/import', async (req, res) => {
  try {
    const { threadId, profile, projectId } = (req.body ?? {}) as {
      threadId?: string
      profile?: string | null
      projectId?: string
    }
    const dir = profile && listProfiles().some((p) => p.dir === profile) ? profile : defaultProfileDir()
    if (!dir) throw new Error('Nenhum perfil do Claude encontrado')
    const file = findThreadFile(dir, String(threadId ?? ''))
    if (!file) throw new Error('Thread não encontrada nesse perfil')
    const { cwd, title } = describeThread(file)
    const entries = await readThreadEntries(file)
    const session = manager.importSession({
      projectId: String(projectId ?? ''),
      threadId: String(threadId),
      profile: dir,
      cwd,
      title,
      entries,
    })
    res.json(session)
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

app.post('/api/sessions', (req, res) => {
  try {
    const { projectId, prompt, model, effort, permissionMode, codebasePath, profile, attachments } =
      (req.body ?? {}) as {
        projectId?: string
        prompt?: string
        model?: string | null
        effort?: string | null
        permissionMode?: string
        codebasePath?: string | null
        profile?: string | null
        attachments?: MsgAttachment[]
      }
    if (!prompt || !prompt.trim()) throw new Error('O primeiro prompt é obrigatório')
    const session = manager.createSession(
      String(projectId ?? ''),
      prompt,
      model ?? null,
      effort ?? null,
      permissionMode,
      codebasePath ?? null,
      profile ?? null,
      Array.isArray(attachments) ? attachments : [],
    )
    res.json(session)
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

app.post('/api/sessions/:id/close', (req, res) => {
  manager.closeCard(req.params.id)
  res.json({ ok: true })
})

app.delete('/api/sessions/:id', (req, res) => {
  manager.deleteSession(req.params.id)
  res.json({ ok: true })
})

app.post('/api/sessions/:id/reopen', (req, res) => {
  manager.reopenCard(req.params.id)
  res.json({ ok: true })
})

// Salva um anexo (bytes crus) dentro da pasta do projeto, em greed-anexos/.
// Só é usado para arquivos grandes/binários; texto pequeno vai inline pelo cliente.
function saveAttachment(
  projectPath: string,
  rawName: string,
  body: unknown,
): { name: string; rel: string; abs: string; bytes: Buffer } {
  const safeName = path.basename(rawName).replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'arquivo'
  if (!Buffer.isBuffer(body) || body.length === 0) throw new Error('Arquivo vazio')
  const dir = path.join(projectPath, 'greed-anexos')
  fs.mkdirSync(dir, { recursive: true })
  const abs = path.join(dir, safeName)
  fs.writeFileSync(abs, body)
  return { name: safeName, rel: path.join('greed-anexos', safeName), abs, bytes: body }
}

const rawBody = express.raw({ type: '*/*', limit: '64mb' })

app.post('/api/sessions/:id/attachments', rawBody, (req, res) => {
  try {
    const projectPath = manager.projectPathForSession(req.params.id)
    if (!projectPath) throw new Error('Sessão não encontrada')
    const f = saveAttachment(projectPath, String(req.query.name ?? 'arquivo'), req.body)
    manager.ingestAttachment(req.params.id, f.name, f.rel, f.bytes) // extrai + indexa (async)
    res.json({ path: f.rel, abs: f.abs })
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// Mesma coisa, mas por projeto: usado pelo modal de novo chat, onde ainda não há sessão.
app.post('/api/projects/:id/attachments', rawBody, (req, res) => {
  try {
    const project = projects.get(req.params.id)
    if (!project) throw new Error('Projeto não encontrado')
    const f = saveAttachment(project.path, String(req.query.name ?? 'arquivo'), req.body)
    manager.ingestProjectAttachment(project.id, f.name, f.rel, f.bytes)
    res.json({ path: f.rel, abs: f.abs })
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// ── preview: ver e baixar o que o agente escreveu, sem sair do card ──

// lista de slash commands válidos nesta pasta (Claude Code + os do Greed)
app.get('/api/sessions/:id/commands', async (req, res) => {
  const cwd = manager.previewRootForSession(req.params.id)
  if (!cwd) {
    res.status(404).json({ error: 'Sessão não encontrada' })
    return
  }
  res.json({ commands: await commandsFor(cwd), btw: manager.btwHistory(req.params.id) })
})

// só os entregáveis deste chat: a pasta é do projeto e é dividida com os outros
app.get('/api/sessions/:id/preview', (req, res) => {
  const roots = manager.previewRootsForSession(req.params.id)
  if (roots.length === 0) {
    res.status(404).json({ error: 'Sessão não encontrada' })
    return
  }
  res.json({ files: manager.previewFilesForSession(req.params.id) })
})

// Serve os arquivos da pasta de trabalho (html + css/js/imagens que ele referencia).
// Só hosts permitidos (guarda global) e só dentro da raiz — nada de subir com "..".
// A defesa contra ".." não depende do guarda: vale igual com o servidor na rede.
app.get('/preview/:id/*', (req, res) => {
  const roots = manager.previewRootsForSession(req.params.id)
  if (roots.length === 0) {
    res.status(404).send('sessão não encontrada')
    return
  }
  // ?root=N diz de qual pasta veio o arquivo; as outras ficam de reserva, caso
  // ele tenha movido o arquivo depois que a lista foi montada
  const asked = Number(req.query.root)
  const first = Number.isInteger(asked) ? roots[asked] : undefined
  const candidates = first ? [first, ...roots.filter((r) => r !== first)] : roots
  const rel = decodeURIComponent(String((req.params as Record<string, string>)[0] ?? ''))
  let real = ''
  let realRoot = ''
  for (const root of candidates) {
    try {
      const rr = fs.realpathSync(root)
      const abs = fs.realpathSync(path.resolve(root, rel)) // resolve ".." e link simbólico
      if (abs !== rr && !abs.startsWith(rr + path.sep)) continue // fora da pasta
      real = abs
      realRoot = rr
      break
    } catch {
      // não existe nesta pasta: tenta a próxima
    }
  }
  if (!real || !realRoot) {
    res.status(404).send('arquivo não encontrado')
    return
  }
  // ?download=1 faz o navegador salvar em vez de abrir
  if (req.query.download) res.download(real)
  else res.sendFile(real)
})

if (process.env.GREED_SERVE_STATIC) {
  const dist = path.resolve('web/dist')
  app.use(express.static(dist))
  app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')))
}

server.listen(PORT, guard.bindHost, () => {
  const addr = server.address()
  const port = addr && typeof addr === 'object' ? addr.port : PORT
  const shown = guard.bindHost.includes(':') ? `[${guard.bindHost}]` : guard.bindHost
  console.log(`[greed] server rodando em http://${guard.requireHeaders ? shown : 'localhost'}:${port}`)
  if (guard.requireHeaders) {
    // fora do loopback não há autenticação: quem alcança o endereço manda no servidor
    console.log(`[greed] hosts aceitos: ${[...guard.allowedHosts].join(', ')}`)
  }
  // migra a memória para o OptMem e adianta as compressões, antes de qualquer sessão
  warmMemory(projects.list().map((p) => p.id))
})

let closing = false
function shutdown(code = 0): void {
  if (closing) return
  closing = true
  usagePoller.stop()
  manager.shutdown()
  store.flush()
  process.exit(code)
}
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
process.on('exit', () => store.flush())
process.on('uncaughtException', (err) => {
  console.error('[greed] uncaughtException:', err)
  shutdown(1)
})
process.on('unhandledRejection', (err) => {
  console.error('[greed] unhandledRejection:', err)
})
