import { Bot, ChevronDown, ChevronRight, Clock, Wrench } from 'lucide-react'
import { activityHeadline, type ActivityView } from './useActivity'

interface Props {
  a: ActivityView
  working: boolean
  open: boolean
  onToggle: () => void
}

export function ActivityRail({ a, working, open, onToggle }: Props) {
  // idle real e sem histórico de atividade: some
  if (!working && a.items.length === 0) return null
  const head = activityHeadline(a, working)
  const live = a.running.length > 0
  return (
    <button className={`act-rail ${open ? 'open' : ''}`} onClick={onToggle} data-tip="Ver o que rodou neste turno">
      {live ? <span className="act-spin" /> : <span className="act-rail-dot" />}
      <span className="act-rail-head">{head || '…'}</span>
      <span className="act-rail-counts">
        {a.toolCount > 0 && (
          <span>
            <Wrench size={10} />
            {a.toolCount}
          </span>
        )}
        {a.subagentCount > 0 && (
          <span>
            <Bot size={10} />
            {a.subagentCount}
          </span>
        )}
        {a.taskCount > 0 && (
          <span>
            <Clock size={10} />
            {a.taskCount}
          </span>
        )}
      </span>
      <span className="act-rail-chev">{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</span>
    </button>
  )
}
