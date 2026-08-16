import type { ActivityItem } from '../../../../shared/types'

const KIND_GLYPH: Record<ActivityItem['kind'], string> = {
  tool: '⚙',
  subagent: '⧉',
  task: '⌁',
}

export function ActivityRow({ node }: { node: ActivityItem }) {
  return (
    <div className="act-row" data-st={node.status} data-kind={node.kind}>
      <span className="act-mark">
        {node.status === 'running' ? (
          <span className="act-spin" />
        ) : node.status === 'error' ? (
          '✗'
        ) : (
          '✓'
        )}
      </span>
      <span className="act-glyph">{KIND_GLYPH[node.kind]}</span>
      <span className="act-name">{node.name}</span>
      {node.detail && <span className="act-detail">{node.detail}</span>}
      <span className="act-meta">
        {node.elapsedMs != null && node.elapsedMs > 0 && `${Math.round(node.elapsedMs / 1000)}s`}
        {node.tokens != null && node.tokens > 0 && ` ${node.tokens}tok`}
      </span>
    </div>
  )
}
