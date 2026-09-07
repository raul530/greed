import { Bot, Check, Clock, Wrench, X } from 'lucide-react'
import type { ActivityItem } from '../../../../shared/types'

const KIND_ICON: Record<ActivityItem['kind'], typeof Wrench> = {
  tool: Wrench,
  subagent: Bot,
  task: Clock,
}

export function ActivityRow({ node }: { node: ActivityItem }) {
  const Glyph = KIND_ICON[node.kind]
  return (
    <div className="act-row" data-st={node.status} data-kind={node.kind}>
      <span className="act-mark">
        {node.status === 'running' ? (
          <span className="act-spin" />
        ) : node.status === 'error' ? (
          <X size={10} />
        ) : (
          <Check size={10} />
        )}
      </span>
      <span className="act-glyph">
        <Glyph size={11} />
      </span>
      <span className="act-name">{node.name}</span>
      {node.detail && <span className="act-detail">{node.detail}</span>}
      <span className="act-meta">
        {node.elapsedMs != null && node.elapsedMs > 0 && `${Math.round(node.elapsedMs / 1000)}s`}
        {node.tokens != null && node.tokens > 0 && ` ${node.tokens}tok`}
      </span>
    </div>
  )
}
