import { useEffect, useState } from 'react'
import { api, type BrowseResult } from '../api'

interface Props {
  onPick: (path: string) => void
  onClose: () => void
}

export function FolderPicker({ onPick, onClose }: Props) {
  const [data, setData] = useState<BrowseResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = (dir?: string) => {
    setLoading(true)
    setError(null)
    api
      .browse(dir)
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false))
  }

  useEffect(() => load(), [])

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal picker">
        <h2>Escolher pasta / repositório</h2>
        <div className="picker-path" title={data?.path}>
          {data?.path ?? '…'}
          {data?.isRepo && <span className="repo-badge">git</span>}
        </div>
        <div className="picker-list">
          {data?.parent && (
            <button className="picker-item up" onClick={() => load(data.parent!)}>
              ‹ ..
            </button>
          )}
          {data?.entries.map((e) => (
            <button
              key={e.name}
              className="picker-item"
              onClick={() => load(`${data.path}/${e.name}`)}
            >
              <span className="picker-name">{e.name}</span>
              {e.isRepo && <span className="repo-badge">git</span>}
            </button>
          ))}
          {data && data.entries.length === 0 && (
            <div className="picker-empty">Sem subpastas aqui.</div>
          )}
          {loading && <div className="picker-empty">Carregando…</div>}
        </div>
        {error && <div className="modal-error">{error}</div>}
        <div className="modal-actions">
          <button onClick={onClose}>Cancelar</button>
          <button className="primary" disabled={!data} onClick={() => data && onPick(data.path)}>
            Usar esta pasta
          </button>
        </div>
      </div>
    </div>
  )
}
