import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { ClientMsg, ServerMsg } from '../../shared/types'
import { api } from './api'
import { HistoryPanel } from './components/HistoryPanel'
import { NewChatModal } from './components/NewChatModal'
import { ProjectsModal } from './components/ProjectsModal'
import { SessionCard } from './components/SessionCard'
import { initialState, reducer } from './store'
import { connectWS, type WSHandle } from './ws'

function showNotification(msg: Extract<ServerMsg, { type: 'notify' }>) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  try {
    new Notification(msg.kind === 'waiting' ? `⚠️ ${msg.title}` : `✅ ${msg.title}`, {
      body: msg.body,
      tag: `greed-${msg.sessionId}`,
    })
  } catch {
    // Notification pode lançar em contextos sem suporte — ignora
  }
}

export function App() {
  const [state, dispatch] = useReducer(reducer, initialState)
  const wsRef = useRef<WSHandle | null>(null)
  const [modal, setModal] = useState<'none' | 'new' | 'projects'>('none')
  const [historyOpen, setHistoryOpen] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const inputRefs = useRef(new Map<string, HTMLTextAreaElement>())
  const [notifPerm, setNotifPerm] = useState<NotificationPermission>(
    typeof Notification !== 'undefined' ? Notification.permission : 'denied',
  )

  useEffect(() => {
    const ws = connectWS(
      (msg) => {
        dispatch({ type: 'server', msg })
        if (msg.type === 'notify') showNotification(msg)
      },
      (connected) => dispatch({ type: 'ws_status', connected }),
    )
    wsRef.current = ws
    return () => {
      ws.close()
      wsRef.current = null
    }
  }, [])

  const send = useCallback((m: ClientMsg): boolean => wsRef.current?.send(m) ?? false, [])

  const call = useCallback((p: Promise<unknown>) => {
    p.catch((err) => console.error('[greed] ação falhou:', err))
  }, [])

  const openSessions = useMemo(
    () =>
      Object.values(state.sessions)
        .filter((s) => s.open)
        .sort((a, b) => a.createdAt - b.createdAt),
    [state.sessions],
  )
  const closedSessions = useMemo(
    () =>
      Object.values(state.sessions)
        .filter((s) => !s.open)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [state.sessions],
  )

  // ignora id de expansão obsoleto (sessão fechada por outra aba, etc.)
  const expanded = expandedId && state.sessions[expandedId]?.open ? expandedId : null

  const focusCard = useCallback(
    (id: string) => {
      const el = inputRefs.current.get(id)
      if (!el) return
      el.focus()
      el.closest('.card')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      send({ type: 'mark_read', sessionId: id })
    },
    [send],
  )

  // Atalhos: ⌘/Ctrl+1..9 foca card (control groups de RTS), ⌘/Ctrl+K novo chat, Esc fecha
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
        if (e.key >= '1' && e.key <= '9') {
          const target = openSessions[Number(e.key) - 1]
          if (target) {
            e.preventDefault()
            focusCard(target.id)
          }
          return
        }
        if (e.key.toLowerCase() === 'k') {
          e.preventDefault()
          setModal('new')
          return
        }
      }
      if (e.key === 'Escape') {
        setExpandedId(null)
        setModal('none')
        setHistoryOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openSessions, focusCard])

  const requestNotif = () => {
    void Notification.requestPermission().then(setNotifPerm)
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-logo">💰</span>
          <b>Greed</b>
          <span className={state.connected ? 'conn ok' : 'conn off'}>
            {state.connected ? 'conectado' : 'reconectando…'}
          </span>
        </div>
        <div className="topbar-actions">
          {notifPerm === 'default' && (
            <button onClick={requestNotif} title="Notificações de desktop quando um chat terminar">
              🔔 Ativar notificações
            </button>
          )}
          <button onClick={() => setModal('projects')}>Projetos</button>
          <button onClick={() => setHistoryOpen(true)}>
            Histórico{closedSessions.length > 0 ? ` (${closedSessions.length})` : ''}
          </button>
          <button className="primary" onClick={() => setModal('new')}>
            + Novo chat <kbd>⌘K</kbd>
          </button>
        </div>
      </header>

      {openSessions.length === 0 ? (
        <div className="empty-state">
          <div className="empty-logo">💰</div>
          <p>Nenhum chat aberto.</p>
          <button className="primary" onClick={() => setModal('new')}>
            + Novo chat
          </button>
          <p className="empty-hint">
            ⌘K abre um chat · ⌘1–9 pula entre cards · cards fechados ficam no Histórico
          </p>
        </div>
      ) : (
        <main className="grid">
          {openSessions.map((s, i) => (
            <SessionCard
              key={s.id}
              session={s}
              entries={state.transcripts[s.id] ?? []}
              permissions={state.permissions[s.id] ?? []}
              index={i}
              expanded={expanded === s.id}
              connected={state.connected}
              onSend={(text) => send({ type: 'user_message', sessionId: s.id, text })}
              onInterrupt={() => send({ type: 'interrupt', sessionId: s.id })}
              onClose={() => {
                if (expandedId === s.id) setExpandedId(null)
                call(api.closeSession(s.id))
              }}
              onToggleExpand={() => setExpandedId(expandedId === s.id ? null : s.id)}
              onSeen={() => send({ type: 'mark_read', sessionId: s.id })}
              onPermission={(requestId, behavior) =>
                send({ type: 'permission_response', sessionId: s.id, requestId, behavior })
              }
              registerInput={(el) => {
                if (el) inputRefs.current.set(s.id, el)
                else inputRefs.current.delete(s.id)
              }}
            />
          ))}
        </main>
      )}

      {expanded && <div className="expand-backdrop" onMouseDown={() => setExpandedId(null)} />}

      {modal === 'new' && (
        <NewChatModal
          projects={state.projects}
          onClose={() => setModal('none')}
          onManageProjects={() => setModal('projects')}
        />
      )}
      {modal === 'projects' && (
        <ProjectsModal projects={state.projects} onClose={() => setModal('none')} />
      )}
      {historyOpen && (
        <HistoryPanel
          sessions={closedSessions}
          onClose={() => setHistoryOpen(false)}
          onReopen={(id) => {
            call(api.reopenSession(id))
            setHistoryOpen(false)
          }}
        />
      )}
    </div>
  )
}
