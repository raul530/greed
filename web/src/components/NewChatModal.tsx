import { useEffect, useRef, useState } from 'react'
import type { Project } from '../../../shared/types'
import { api } from '../api'

interface Props {
  projects: Project[]
  onClose: () => void
  onManageProjects: () => void
}

export function NewChatModal({ projects, onClose, onManageProjects }: Props) {
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '')
  const [prompt, setPrompt] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const taRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => taRef.current?.focus(), [])

  // resolve na hora: cobre projetos que chegam depois do mount ou id que sumiu
  const effectiveId = projects.some((p) => p.id === projectId) ? projectId : (projects[0]?.id ?? '')

  const submit = async () => {
    if (!effectiveId || !prompt.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      await api.newSession(effectiveId, prompt)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <h2>Novo chat</h2>
        {projects.length === 0 ? (
          <div className="modal-empty">
            <p>Nenhum projeto registrado ainda. Um projeto é uma pasta com seu CLAUDE.md e MCPs.</p>
            <button className="primary" onClick={onManageProjects}>
              Registrar projeto
            </button>
          </div>
        ) : (
          <>
            <label>
              Projeto
              <select value={effectiveId} onChange={(e) => setProjectId(e.target.value)}>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} — {p.path}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Primeiro prompt
              <textarea
                ref={taRef}
                rows={5}
                value={prompt}
                placeholder="O que essa sessão deve fazer?"
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault()
                    void submit()
                  }
                }}
              />
            </label>
            {error && <div className="modal-error">{error}</div>}
            <div className="modal-actions">
              <button onClick={onClose}>Cancelar</button>
              <button
                className="primary"
                disabled={!effectiveId || !prompt.trim() || busy}
                onClick={() => void submit()}
              >
                {busy ? 'Abrindo…' : 'Iniciar (⌘⏎)'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
