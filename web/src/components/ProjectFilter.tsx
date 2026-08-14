import { useEffect, useRef, useState } from 'react'

interface ProjectOnBoard {
  id: string
  name: string
  count: number
}

interface Props {
  projects: ProjectOnBoard[]
  hidden: Set<string>
  onToggle: (projectId: string) => void
}

export function ProjectFilter({ projects, hidden, onToggle }: Props) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const hiddenCount = projects.filter((p) => hidden.has(p.id)).length

  return (
    <div className="filter" ref={ref}>
      <button className={hiddenCount > 0 ? 'filter-active' : ''} onClick={() => setOpen((o) => !o)}>
        Filtro{hiddenCount > 0 ? ` (${projects.length - hiddenCount}/${projects.length})` : ''} ▾
      </button>
      {open && (
        <div className="filter-menu">
          {projects.map((p) => (
            <label key={p.id} className="filter-item">
              <input
                type="checkbox"
                checked={!hidden.has(p.id)}
                onChange={() => onToggle(p.id)}
              />
              <span className="filter-name">{p.name}</span>
              <span className="filter-count">{p.count}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  )
}
