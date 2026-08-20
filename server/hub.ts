import type { WebSocket, WebSocketServer } from 'ws'
import type { ClientMsg, ServerMsg } from '../shared/types'

function isValidClientMsg(m: unknown): m is ClientMsg {
  if (!m || typeof m !== 'object') return false
  const msg = m as Record<string, unknown>
  switch (msg.type) {
    case 'user_message':
    case 'btw':
      return (
        typeof msg.sessionId === 'string' &&
        typeof msg.text === 'string' &&
        (msg.attachments === undefined || Array.isArray(msg.attachments))
      )
    case 'permission_response':
      return (
        typeof msg.sessionId === 'string' &&
        typeof msg.requestId === 'string' &&
        (msg.behavior === 'allow' || msg.behavior === 'deny')
      )
    case 'interrupt':
    case 'mark_read':
      return typeof msg.sessionId === 'string'
    case 'set_title':
      return typeof msg.sessionId === 'string' && typeof msg.title === 'string'
    case 'set_model':
      return typeof msg.sessionId === 'string' && (msg.model === null || typeof msg.model === 'string')
    case 'set_effort':
      return typeof msg.sessionId === 'string' && (msg.effort === null || typeof msg.effort === 'string')
    case 'set_profile':
      return (
        typeof msg.sessionId === 'string' && (msg.profile === null || typeof msg.profile === 'string')
      )
    case 'set_permission_mode':
      return typeof msg.sessionId === 'string' && typeof msg.mode === 'string'
    default:
      return false
  }
}

export class Hub {
  private clients = new Set<WebSocket>()
  private messageHandler: ((msg: ClientMsg) => void) | null = null
  private connectHandler: ((ws: WebSocket) => void) | null = null

  constructor(wss: WebSocketServer) {
    wss.on('connection', (ws) => {
      this.clients.add(ws)
      ws.on('close', () => this.clients.delete(ws))
      ws.on('error', () => this.clients.delete(ws))
      ws.on('message', (data) => {
        let parsed: unknown
        try {
          parsed = JSON.parse(String(data))
        } catch {
          return // JSON malformado — ignora
        }
        if (!isValidClientMsg(parsed)) return // mensagem fora do protocolo — ignora
        try {
          this.messageHandler?.(parsed)
        } catch (err) {
          // um handler que lança não pode derrubar o servidor
          console.error('[greed] erro ao tratar mensagem do cliente:', err)
        }
      })
      this.connectHandler?.(ws)
    })
  }

  /** quantos navegadores estão ligados agora (poller de consumo só roda com plateia) */
  clientCount(): number {
    return this.clients.size
  }

  onMessage(handler: (msg: ClientMsg) => void): void {
    this.messageHandler = handler
  }

  onConnect(handler: (ws: WebSocket) => void): void {
    this.connectHandler = handler
  }

  sendTo(ws: WebSocket, msg: ServerMsg): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
  }

  broadcast(msg: ServerMsg): void {
    const data = JSON.stringify(msg)
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) ws.send(data)
    }
  }
}
