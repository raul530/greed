import { useState } from 'react'
import type { Project } from '../../../shared/types'
import { api } from '../api'

interface Props {
  projects: Project[]
  onClose: () => void
}

export function ProjectsModal({ projects, onClose }: Props) {
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const add = async () => {
    if (!name.trim() || !path.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      await api.addProject(name, path)
      setName('')
      setPath('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <h2>Projetos</h2>
        <p className="modal-hint">
          Cada projeto é uma pasta. A sessão roda com esse working directory e usa o CLAUDE.md e o
          .mcp.json (formato padrão do Claude Code) que estiverem lá.
        </p>
        {projects.length > 0 && (
          <ul className="project-list">
            {projects.map((p) => (
              <li key={p.id}>
                <div>
                  <b>{p.name}</b>
                  <span className="project-path">{p.path}</span>
                </div>
                <button
                  className="icon"
                  title="Remover projeto (não apaga a pasta)"
                  onClick={() =>
                    api
                      .removeProject(p.id)
                      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
                  }
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="project-add">
          <input
            placeholder="Nome (ex.: Trabalho)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            placeholder="Pasta (ex.: ~/repos/meu-projeto)"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void add()}
          />
          <button className="primary" disabled={!name.trim() || !path.trim() || busy} onClick={() => void add()}>
            Adicionar
          </button>
        </div>
        {error && <div className="modal-error">{error}</div>}
        <div className="modal-actions">
          <button onClick={onClose}>Fechar</button>
        </div>
      </div>
    </div>
  )
}
