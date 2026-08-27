import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { ClientMsg, Profile, ServerMsg } from '../../shared/types'
import { api } from './api'
import { BtwConsole } from './components/BtwConsole'
import { FleetView } from './components/fleet/FleetView'
import { HistoryPanel } from './components/HistoryPanel'
import { ImportModal } from './components/ImportModal'
import { NewChatModal } from './components/NewChatModal'
import { ProjectFilter } from './components/ProjectFilter'
import { ProjectsModal } from './components/ProjectsModal'
import { SessionCard } from './components/SessionCard'
import { TooltipLayer } from './components/Tooltip'
import { UsageView } from './components/UsageView'
import { initialState, reducer } from './store'
import { connectWS, type WSHandle } from './ws'

const HIDDEN_KEY = 'greed:hiddenProjects'
const THEME_KEY = 'greed:theme'
const DARK_THEMES = ['orange', 'purple', 'green'] as const
const LIGHT_THEMES = ['paper', 'sage', 'lilac'] as const
const MODES = ['auto', 'dark', 'light'] as const

type Mode = (typeof MODES)[number]

/** o tema escuro e o claro preferidos, e quem decide qual dos dois vale agora */
interface ThemePref {
  mode: Mode
  dark: string
  light: string
}

const MODE_LABEL: Record<Mode, { icon: string; label: string; tip: string }> = {
  auto: {
    icon: '◐',
    label: 'auto',
    tip: 'Seguindo o sistema: claro de dia, escuro ao anoitecer. Clique pra fixar no escuro.',
  },
  dark: { icon: '☾', label: 'escuro', tip: 'Fixo no escuro. Clique pra fixar no claro.' },
  light: { icon: '☀', label: 'claro', tip: 'Fixo no claro. Clique pra seguir o sistema.' },
}

function loadTheme(): ThemePref {
  const fallback: ThemePref = { mode: 'auto', dark: 'orange', light: 'paper' }
  try {
    const raw = localStorage.getItem(THEME_KEY)
    if (!raw) return fallback
    // versão antiga guardava só o nome do tema escuro
    if (!raw.startsWith('{')) return { ...fallback, dark: raw }
    return { ...fallback, ...(JSON.parse(raw) as Partial<ThemePref>) }
  } catch {
    return fallback
  }
}

/** telas da HUD — o board é a de sempre; as outras entram aqui */
const VIEWS = [
  { id: 'board', label: 'Board' },
  { id: 'fleet', label: 'Agentes' },
  { id: 'usage', label: 'Consumo' },
] as const
type View = (typeof VIEWS)[number]['id']

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
  const [modal, setModal] = useState<'none' | 'new' | 'projects' | 'import'>('none')
  const [view, setView] = useState<View>('board')
  const [historyOpen, setHistoryOpen] = useState(false)
  /** sessão cujo console de /btw está aberto (um por vez) */
  const [btwSession, setBtwSession] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [hiddenProjects, setHiddenProjects] = useState<Set<string>>(loadHidden)
  const [profiles, setProfiles] = useState<{ list: Profile[]; default: string | null }>({
    list: [],
    default: null,
  })

  useEffect(() => {
    void api
      .profiles()
      .then(({ profiles: list, default: def }) => setProfiles({ list, default: def }))
      .catch(() => {})
  }, [modal])
  const [theme, setTheme] = useState<ThemePref>(loadTheme)
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  )
  const inputRefs = useRef(new Map<string, HTMLTextAreaElement>())

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const read = () => setSystemDark(mq.matches)
    mq.addEventListener('change', read)
    return () => mq.removeEventListener('change', read)
  }, [])

  const scheme = theme.mode === 'auto' ? (systemDark ? 'dark' : 'light') : theme.mode
  const activeTheme = scheme === 'dark' ? theme.dark : theme.light

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', activeTheme)
    document.documentElement.setAttribute('data-scheme', scheme)
    try {
      localStorage.setItem(THEME_KEY, JSON.stringify(theme))
    } catch {
      // localStorage indisponível — tema só não persiste
    }
  }, [theme, activeTheme, scheme])
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

  // maior limite em uso — fica sempre à vista na telemetria do topo
  const usagePeak = useMemo(
    () =>
      state.usage && state.usage.limits.length > 0
        ? Math.max(...state.usage.limits.map((l) => l.percent))
        : null,
    [state.usage],
  )

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
          setView('board') // o card novo nasce no board
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
          <nav className="hud-nav" aria-label="Telas">
            {VIEWS.map((v) => (
              <button
                key={v.id}
                className={`navtab ${view === v.id ? 'active' : ''}`}
                aria-current={view === v.id}
                onClick={() => setView(v.id)}
              >
                {v.label}
              </button>
            ))}
          </nav>
          <div className="telemetry">
            <span className="tcell">
              <i>sessions</i>
              <b>{openSessions.length + closedSessions.length}</b>
            </span>
            <button
              className="tcell tcell-btn"
              onClick={() => setView('fleet')}
              title="Ver os agentes trabalhando"
            >
              <i>in-flight</i>
              <b>{openSessions.filter((s) => s.status === 'working').length}</b>
            </button>
            <span className="tcell">
              <i>open</i>
              <b>{openSessions.length}</b>
            </span>
            <button
              className={`tcell tcell-btn ${usagePeak != null && usagePeak >= 90 ? 'hot' : ''}`}
              onClick={() => setView('usage')}
              title="Consumo da assinatura"
            >
              <i>limite</i>
              <b>{usagePeak == null ? '—' : `${usagePeak}%`}</b>
            </button>
          </div>
        </div>
        <div className="topbar-actions">
          <div className="themes">
            <button
              className={`theme-mode ${theme.mode}`}
              data-tip={MODE_LABEL[theme.mode].tip}
              onClick={() =>
                setTheme((p) => ({ ...p, mode: MODES[(MODES.indexOf(p.mode) + 1) % MODES.length] }))
              }
            >
              {MODE_LABEL[theme.mode].icon}
              <i>{MODE_LABEL[theme.mode].label}</i>
            </button>
            {[...DARK_THEMES, ...LIGHT_THEMES].map((t) => {
              const light = (LIGHT_THEMES as readonly string[]).includes(t)
              return (
                <button
                  key={t}
                  className={[
                    'swatch',
                    t,
                    (light ? theme.light : theme.dark) === t ? 'active' : '',
                    activeTheme === t ? 'live' : '',
                    t === LIGHT_THEMES[0] ? 'group-start' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  data-tip={
                    activeTheme === t
                      ? `${t} — em uso agora`
                      : `${t} — seu tema ${light ? 'claro' : 'escuro'}`
                  }
                  aria-label={`tema ${t}`}
                  onClick={() => setTheme((p) => (light ? { ...p, light: t } : { ...p, dark: t }))}
                />
              )
            })}
          </div>
          {notifPerm === 'default' && (
            <button onClick={requestNotif} title="Notificações de desktop quando um chat terminar">
              🔔 Ativar notificações
            </button>
          )}
          {view === 'board' && projectsOnBoard.length > 1 && (
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
          <button
            className="primary"
            onClick={() => {
              setView('board')
              setModal('new')
            }}
          >
            + Novo chat <kbd>⌘K</kbd>
          </button>
        </div>
      </header>

      {view === 'usage' ? (
        <UsageView
          usage={state.usage}
          error={state.usageError}
          profiles={profiles.list}
          defaultProfile={profiles.default}
        />
      ) : view === 'fleet' ? (
        <FleetView
          sessions={state.sessions}
          runs={state.fleetRuns}
          spans={state.fleetSpans}
          onOpen={(id) => {
            setView('board')
            requestAnimationFrame(() => focusCard(id))
          }}
        />
      ) : openSessions.length === 0 ? (
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
              activity={state.activity[s.id] ?? []}
              index={i}
              expanded={expanded === s.id}
              connected={state.connected}
              onSend={(text, attachments) =>
                send({ type: 'user_message', sessionId: s.id, text, attachments })
              }
              onBtw={(text) => {
                setBtwSession(s.id)
                if (text) send({ type: 'btw', sessionId: s.id, text })
              }}
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
              onRename={(title) => send({ type: 'set_title', sessionId: s.id, title })}
              onSetModel={(model) => send({ type: 'set_model', sessionId: s.id, model })}
              onSetEffort={(effort) => send({ type: 'set_effort', sessionId: s.id, effort })}
              profiles={profiles.list}
              defaultProfile={profiles.default}
              onSetProfile={(profile) => send({ type: 'set_profile', sessionId: s.id, profile })}
              onSetPermissionMode={(mode) =>
                send({ type: 'set_permission_mode', sessionId: s.id, mode })
              }
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
          profiles={profiles.list}
          onClose={() => setModal('none')}
          onManageProjects={() => setModal('projects')}
          onImport={() => setModal('import')}
        />
      )}
      {modal === 'import' && (
        <ImportModal
          projects={state.projects}
          profiles={profiles.list}
          defaultProfile={profiles.default}
          onClose={() => setModal('none')}
          onBack={() => setModal('new')}
        />
      )}
      {modal === 'projects' && (
        <ProjectsModal projects={state.projects} onClose={() => setModal('none')} />
      )}
      {historyOpen && (
        <HistoryPanel
          sessions={closedSessions}
          onRename={(id, title) => send({ type: 'set_title', sessionId: id, title })}
          onDelete={(id) => call(api.deleteSession(id))}
          onClose={() => setHistoryOpen(false)}
          onReopen={(id) => {
            call(api.reopenSession(id))
            setHistoryOpen(false)
            setView('board')
          }}
        />
      )}
      {btwSession && state.sessions[btwSession] && (
        <BtwConsole
          title={`${state.sessions[btwSession].projectName} — ${state.sessions[btwSession].title}`}
          exchanges={state.btw[btwSession] ?? []}
          onAsk={(text) => send({ type: 'btw', sessionId: btwSession, text })}
          onClose={() => setBtwSession(null)}
        />
      )}
      <TooltipLayer />
    </div>
  )
}
