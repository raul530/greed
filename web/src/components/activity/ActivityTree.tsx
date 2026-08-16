import { useEffect } from 'react'
import type { ActivityItem } from '../../../../shared/types'
import { ActivityRow } from './ActivityRow'
import type { ActivityView } from './useActivity'

interface Props {
  a: ActivityView
  onClose: () => void
}

export function ActivityTree({ a, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const renderNode = (node: ActivityItem, depth: number) => {
    const kids = depth < 6 ? a.childrenOf(node.id) : []
    return (
      <div key={node.id} className="act-node">
        <ActivityRow node={node} />
        {kids.length > 0 && (
          <div className="act-children">{kids.map((k) => renderNode(k, depth + 1))}</div>
        )}
      </div>
    )
  }

  const empty = a.roots.length === 0 && a.tasks.length === 0

  return (
    <div className="act-tree">
      <div className="act-tree-head">
        <span>atividade</span>
        <button className="icon" onClick={onClose} title="Fechar">
          ✕
        </button>
      </div>
      <div className="act-tree-body">
        {a.tasks.length > 0 && (
          <div className="act-bg">
            <div className="act-bg-label">2º plano</div>
            {a.tasks.map((t) => (
              <ActivityRow key={t.id} node={t} />
            ))}
          </div>
        )}
        {empty && <div className="act-empty">sem atividade neste turno</div>}
        {a.roots.map((r) => renderNode(r, 0))}
      </div>
    </div>
  )
}
