import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { WebSocketServer } from 'ws'
import { Hub } from './hub'
import { SessionManager } from './manager'
import { ProjectRegistry } from './projects'
import { store } from './store'

const PORT = Number(process.env.GREED_PORT ?? 4517)

/** Só aceita hosts locais — bloqueia DNS rebinding e acesso de outras máquinas. */
function isLocalHostname(host: string | undefined): boolean {
  if (!host) return true // clientes sem Host (ex.: ferramentas locais) são ok
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase()
  return name === 'localhost' || name === '127.0.0.1' || name === '::1'
}

/** Origin de página web só pode ser local — bloqueia hijacking cross-site do WebSocket. */
function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true // conexões sem Origin não vêm de uma página no navegador
  try {
    return isLocalHostname(new URL(origin).hostname)
  } catch {
    return false
  }
}

const app = express()
app.use(express.json({ limit: '2mb' }))
app.use((req, res, next) => {
  if (!isLocalHostname(req.headers.host)) {
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
    if (isAllowedOrigin(info.origin)) cb(true)
    else cb(false, 403, 'Origin não permitida')
  },
})
const hub = new Hub(wss)
const manager = new SessionManager(hub, projects)

hub.onConnect((ws) => hub.sendTo(ws, manager.snapshot()))
hub.onMessage((msg) => {
  switch (msg.type) {
    case 'user_message':
      manager.sendUserMessage(msg.sessionId, msg.text)
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
    case 'set_model':
      manager.setModel(msg.sessionId, msg.model)
      break
    case 'set_effort':
      manager.setEffort(msg.sessionId, msg.effort)
      break
    case 'set_permission_mode':
      manager.setPermissionMode(msg.sessionId, msg.mode)
      break
  }
})

app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
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

app.delete('/api/projects/:id', (req, res) => {
  projects.remove(req.params.id)
  hub.broadcast({ type: 'projects', projects: projects.list() })
  res.json({ ok: true })
})

app.post('/api/sessions', (req, res) => {
  try {
    const { projectId, prompt, model, effort, permissionMode, codebasePath } = (req.body ?? {}) as {
      projectId?: string
      prompt?: string
      model?: string | null
      effort?: string | null
      permissionMode?: string
      codebasePath?: string | null
    }
    if (!prompt || !prompt.trim()) throw new Error('O primeiro prompt é obrigatório')
    const session = manager.createSession(
      String(projectId ?? ''),
      prompt,
      model ?? null,
      effort ?? null,
      permissionMode,
      codebasePath ?? null,
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

app.post('/api/sessions/:id/reopen', (req, res) => {
  manager.reopenCard(req.params.id)
  res.json({ ok: true })
})

// Salva um anexo (bytes crus) dentro da pasta do projeto, em greed-anexos/.
// Só é usado para arquivos grandes/binários; texto pequeno vai inline pelo cliente.
app.post('/api/sessions/:id/attachments', express.raw({ type: '*/*', limit: '64mb' }), (req, res) => {
  try {
    const projectPath = manager.projectPathForSession(req.params.id)
    if (!projectPath) throw new Error('Sessão não encontrada')
    const rawName = String(req.query.name ?? 'arquivo')
    const safeName = path.basename(rawName).replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'arquivo'
    const body = req.body as Buffer
    if (!Buffer.isBuffer(body) || body.length === 0) throw new Error('Arquivo vazio')
    const dir = path.join(projectPath, 'greed-anexos')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, safeName), body)
    const rel = path.join('greed-anexos', safeName)
    manager.ingestAttachment(req.params.id, safeName, rel, body) // extrai + indexa (async)
    res.json({ path: rel })
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

if (process.env.GREED_SERVE_STATIC) {
  const dist = path.resolve('web/dist')
  app.use(express.static(dist))
  app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')))
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[greed] server rodando em http://localhost:${PORT}`)
})

let closing = false
function shutdown(code = 0): void {
  if (closing) return
  closing = true
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
