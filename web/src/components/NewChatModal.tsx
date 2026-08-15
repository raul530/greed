import { useEffect, useRef, useState } from 'react'
import type { Project } from '../../../shared/types'
import { api } from '../api'
import { EFFORTS, MODELS, PERMISSION_MODES } from '../models'

const PERM_KEY = 'greed:permMode'

interface Props {
  projects: Project[]
  onClose: () => void
  onManageProjects: () => void
}

export function NewChatModal({ projects, onClose, onManageProjects }: Props) {
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [permMode, setPermMode] = useState(() => {
    try {
      return localStorage.getItem(PERM_KEY) ?? 'default'
    } catch {
      return 'default'
    }
  })
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
      try {
        localStorage.setItem(PERM_KEY, permMode)
      } catch {
        // localStorage indisponível — só não persiste a preferência
      }
      await api.newSession(effectiveId, prompt, model || null, effort || null, permMode)
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
            <div className="field-row">
              <label>
                Modelo
                <select value={model} onChange={(e) => setModel(e.target.value)}>
                  {MODELS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Esforço
                <select value={effort} onChange={(e) => setEffort(e.target.value)}>
                  {EFFORTS.map((x) => (
                    <option key={x.value} value={x.value}>
                      {x.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label>
              Permissões
              <select value={permMode} onChange={(e) => setPermMode(e.target.value)}>
                {PERMISSION_MODES.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <p className="field-hint">
              Modelo com versão explícita (importa pro consumo). Esforço maior = mais raciocínio, mais
              lento e mais consumo. "Não perguntar" roda tools (bash, edições, MCP) sem pedir aprovação.
              Dá pra trocar tudo no card depois.
            </p>
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
