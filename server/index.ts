import http from 'node:http'
import path from 'node:path'
import express from 'express'
import { WebSocketServer } from 'ws'
import { Hub } from './hub'
import { SessionManager } from './manager'
import { ProjectRegistry } from './projects'
import { store } from './store'

const PORT = Number(process.env.BENTO_PORT ?? 4517)

const app = express()
app.use(express.json({ limit: '2mb' }))

const projects = new ProjectRegistry()
const server = http.createServer(app)
const wss = new WebSocketServer({ server, path: '/ws' })
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
  }
})

app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
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
    const { projectId, prompt } = (req.body ?? {}) as { projectId?: string; prompt?: string }
    if (!prompt || !prompt.trim()) throw new Error('O primeiro prompt é obrigatório')
    const session = manager.createSession(String(projectId ?? ''), prompt)
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

if (process.env.BENTO_SERVE_STATIC) {
  const dist = path.resolve('web/dist')
  app.use(express.static(dist))
  app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')))
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[bento] server rodando em http://localhost:${PORT}`)
})

function shutdown(): void {
  manager.shutdown()
  store.flush()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
