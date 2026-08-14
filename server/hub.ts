import type { WebSocket, WebSocketServer } from 'ws'
import type { ClientMsg, ServerMsg } from '../shared/types'

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
        let msg: ClientMsg
        try {
          msg = JSON.parse(String(data)) as ClientMsg
        } catch {
          return
        }
        this.messageHandler?.(msg)
      })
      this.connectHandler?.(ws)
    })
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
