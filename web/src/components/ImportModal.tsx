import { useEffect, useMemo, useState } from 'react'
import type { ClaudeThread, Profile, Project } from '../../../shared/types'
import { api } from '../api'

interface Props {
  projects: Project[]
  profiles: Profile[]
  defaultProfile: string | null
  onClose: () => void
  onBack: () => void
}

function when(ts: number): string {
  return new Date(ts).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function short(cwd: string): string {
  return cwd.split('/').filter(Boolean).slice(-2).join('/') || cwd
}

export function ImportModal({ projects, profiles, defaultProfile, onClose, onBack }: Props) {
  const [profile, setProfile] = useState<string>(defaultProfile ?? '')
  const [threads, setThreads] = useState<ClaudeThread[] | null>(null)
  const [filter, setFilter] = useState('')
  const [picked, setPicked] = useState<string | null>(null)
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let gone = false
    setThreads(null)
    api
      .threads(profile || null)
      .then(({ threads: list }) => !gone && setThreads(list))
      .catch((err: unknown) => {
        if (gone) return
        setError(err instanceof Error ? err.message : String(err))
        setThreads([])
      })
    return () => {
      gone = true
    }
  }, [profile])

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q || !threads) return threads ?? []
    return threads.filter((t) => `${t.title} ${t.cwd} ${t.preview}`.toLowerCase().includes(q))
  }, [threads, filter])

  const thread = threads?.find((t) => t.id === picked) ?? null

  useEffect(() => {
    if (!thread) return
    const match = projects.find((p) => p.path === thread.cwd)
    if (match) setProjectId(match.id)
  }, [thread, projects])

  const submit = async () => {
    if (!thread || !projectId || busy) return
    setBusy(true)
    setError(null)
    try {
      await api.importThread(thread.id, profile || null, projectId)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal import-modal">
        <h2>Importar thread do Claude</h2>
        <p className="modal-hint">
          Conversas que já existem no Claude Code viram um card aqui. O card retoma a mesma sessão,
          na mesma pasta, então o histórico continua de onde parou. A lista traz as 200 mais
          recentes.
        </p>

        <div className="field-row">
          <label>
            Buscar
            <input
              autoFocus
              placeholder="título, pasta ou trecho"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </label>
          {profiles.length > 1 && (
            <label>
              Conta
              <select value={profile} onChange={(e) => setProfile(e.target.value)}>
                {profiles.map((p) => (
                  <option key={p.dir} value={p.dir} title={p.dir}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        {threads === null ? (
          <p className="modal-hint">Lendo as threads…</p>
        ) : shown.length === 0 ? (
          <p className="modal-hint">Nenhuma thread encontrada.</p>
        ) : (
          <ul className="thread-list">
            {shown.map((t) => (
              <li key={t.id}>
                <button
                  className={`thread-item${picked === t.id ? ' picked' : ''}`}
                  onClick={() => setPicked(t.id)}
                >
                  <span className="thread-head">
                    <b>{t.title}</b>
                    <i>{when(t.updatedAt)}</i>
                  </span>
                  <span className="thread-cwd" title={t.cwd}>
                    {short(t.cwd)}
                  </span>
                  {t.preview && <span className="thread-preview">{t.preview}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}

        <label>
          Projeto (contexto do card)
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} — {p.path}
              </option>
            ))}
          </select>
        </label>

        {error && <div className="modal-error">{error}</div>}
        <div className="modal-actions">
          <button onClick={onBack}>Voltar</button>
          <button className="primary" disabled={!thread || !projectId || busy} onClick={() => void submit()}>
            {busy ? 'Importando…' : 'Importar'}
          </button>
        </div>
      </div>
    </div>
  )
}
