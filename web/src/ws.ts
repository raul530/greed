import type { ClientMsg, ServerMsg } from '../../shared/types'

export interface WSHandle {
  /** retorna false se a mensagem não pôde ser enviada (socket fechado/reconectando) */
  send(m: ClientMsg): boolean
  close(): void
}

export function connectWS(
  onMsg: (m: ServerMsg) => void,
  onStatus: (connected: boolean) => void,
): WSHandle {
  let ws: WebSocket | null = null
  let closed = false
  let timer: number | undefined

  const open = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    ws = new WebSocket(`${proto}://${location.host}/ws`)
    ws.onopen = () => onStatus(true)
    ws.onmessage = (ev) => {
      try {
        onMsg(JSON.parse(String(ev.data)) as ServerMsg)
      } catch {
        // mensagem malformada — ignora
      }
    }
    ws.onclose = () => {
      onStatus(false)
      ws = null
      if (!closed) timer = window.setTimeout(open, 1000)
    }
    ws.onerror = () => ws?.close()
  }
  open()

  return {
    send(m) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(m))
        return true
      }
      return false
    },
    close() {
      closed = true
      window.clearTimeout(timer)
      ws?.close()
    },
  }
}
