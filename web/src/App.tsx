import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { ClientMsg, ServerMsg } from '../../shared/types'
import { api } from './api'
import { HistoryPanel } from './components/HistoryPanel'
import { NewChatModal } from './components/NewChatModal'
import { ProjectFilter } from './components/ProjectFilter'
import { ProjectsModal } from './components/ProjectsModal'
import { SessionCard } from './components/SessionCard'
import { initialState, reducer } from './store'
import { connectWS, type WSHandle } from './ws'

const HIDDEN_KEY = 'greed:hiddenProjects'

function loadHidden(): Set<string> {
  try {
    const raw = localStorage.getItem(HIDDEN_KEY)
    return new Set(raw ? (JSON.parse(raw) as string[]) : [])
  } catch {
    return new Set()
  }
}

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
  const [hiddenProjects, setHiddenProjects] = useState<Set<string>>(loadHidden)
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

  // projetos que têm ao menos um card aberto (base do filtro), com contagem
  const projectsOnBoard = useMemo(() => {
    const counts = new Map<string, { id: string; name: string; count: number }>()
    for (const s of openSessions) {
      const cur = counts.get(s.projectId)
      if (cur) cur.count += 1
      else counts.set(s.projectId, { id: s.projectId, name: s.projectName, count: 1 })
    }
    return [...counts.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [openSessions])

  const visibleSessions = useMemo(
    () => openSessions.filter((s) => !hiddenProjects.has(s.projectId)),
    [openSessions, hiddenProjects],
  )

  const toggleProjectFilter = useCallback((projectId: string) => {
    setHiddenProjects((prev) => {
      const next = new Set(prev)
      if (next.has(projectId)) next.delete(projectId)
      else next.add(projectId)
      try {
        localStorage.setItem(HIDDEN_KEY, JSON.stringify([...next]))
      } catch {
        // localStorage indisponível — filtro só não persiste
      }
      return next
    })
  }, [])

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
          const target = visibleSessions[Number(e.key) - 1]
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
  }, [visibleSessions, focusCard])

  const requestNotif = () => {
    void Notification.requestPermission().then(setNotifPerm)
  }

  const clearFilter = useCallback(() => {
    setHiddenProjects(new Set())
    try {
      localStorage.removeItem(HIDDEN_KEY)
    } catch {
      // ignora
    }
  }, [])

  return (
    <div className="app">
      <header className="topbar">
        <div className="hud-left">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true" />
            <b>Greed</b>
            <span className={`live ${state.connected ? 'on' : 'off'}`}>
              {state.connected ? 'live' : 'offline'}
            </span>
          </div>
          <div className="telemetry">
            <span className="tcell">
              <i>sessions</i>
              <b>{openSessions.length + closedSessions.length}</b>
            </span>
            <span className="tcell">
              <i>in-flight</i>
              <b>{openSessions.filter((s) => s.status === 'working').length}</b>
            </span>
            <span className="tcell">
              <i>open</i>
              <b>{openSessions.length}</b>
            </span>
          </div>
        </div>
        <div className="topbar-actions">
          {notifPerm === 'default' && (
            <button onClick={requestNotif} title="Notificações de desktop quando um chat terminar">
              🔔 Ativar notificações
            </button>
          )}
          {projectsOnBoard.length > 1 && (
            <ProjectFilter
              projects={projectsOnBoard}
              hidden={hiddenProjects}
              onToggle={toggleProjectFilter}
            />
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
          <div className="empty-logo" aria-hidden="true" />
          <p>Nenhum chat aberto.</p>
          <button className="primary" onClick={() => setModal('new')}>
            + Novo chat
          </button>
          <p className="empty-hint">
            ⌘K abre um chat · ⌘1–9 pula entre cards · cards fechados ficam no Histórico
          </p>
        </div>
      ) : visibleSessions.length === 0 ? (
        <div className="empty-state">
          <div className="empty-logo" aria-hidden="true" />
          <p>Todos os projetos estão ocultos pelo filtro.</p>
          <button className="primary" onClick={clearFilter}>
            Mostrar todos
          </button>
        </div>
      ) : (
        <main className="grid">
          {visibleSessions.map((s, i) => (
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
              onSetModel={(model) => send({ type: 'set_model', sessionId: s.id, model })}
              onSetEffort={(effort) => send({ type: 'set_effort', sessionId: s.id, effort })}
              registerInput={(el) => {
                if (el) inputRefs.current.set(s.id, el)
                else inputRefs.current.delete(s.id)
              }}
            />
          ))}
        </main>
      )}

      <footer className="hud-hints">
        <span>⌘K new · ⌘1–9 jump · drag to attach · esc close</span>
        <span className="hud-right">greed // local · {state.connected ? 'link ok' : 'link lost'}</span>
      </footer>

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
