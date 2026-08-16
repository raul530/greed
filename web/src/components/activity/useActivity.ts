import { useMemo } from 'react'
import type { ActivityItem } from '../../../../shared/types'

export interface ActivityView {
  items: ActivityItem[]
  byId: Map<string, ActivityItem>
  running: ActivityItem[]
  /** itens de topo (raiz ou órfãos), exceto tarefas de 2º plano */
  roots: ActivityItem[]
  /** tarefas em 2º plano */
  tasks: ActivityItem[]
  childrenOf: (id: string) => ActivityItem[]
  lastFinished?: ActivityItem
  toolCount: number
  subagentCount: number
  taskCount: number
}

export function useActivity(items: ActivityItem[]): ActivityView {
  return useMemo(() => {
    const byId = new Map(items.map((i) => [i.id, i]))
    const running = items.filter((i) => i.status === 'running')
    const roots = items.filter(
      (i) => i.kind !== 'task' && (i.parentId == null || !byId.has(i.parentId)),
    )
    const tasks = items.filter((i) => i.kind === 'task')
    const childrenOf = (id: string) => items.filter((i) => i.parentId === id && i.kind !== 'task')
    const finished = items
      .filter((i) => i.status !== 'running')
      .sort((a, b) => b.updatedAt - a.updatedAt)
    return {
      items,
      byId,
      running,
      roots,
      tasks,
      childrenOf,
      lastFinished: finished[0],
      toolCount: items.filter((i) => i.kind === 'tool').length,
      subagentCount: items.filter((i) => i.kind === 'subagent').length,
      taskCount: tasks.length,
    }
  }, [items])
}

/** Texto vivo pro rail. Garante que nunca fica vazio enquanto trabalha. */
export function activityHeadline(a: ActivityView, working: boolean): string {
  const withDetail = (i: ActivityItem) => (i.detail ? `${i.name}: ${i.detail}` : i.name).slice(0, 130)
  const run = a.running
  if (run.length === 1) return withDetail(run[0])
  if (run.length > 1) {
    const subs = run.filter((i) => i.kind === 'subagent').length
    const tools = run.filter((i) => i.kind === 'tool').length
    const parts: string[] = []
    if (subs) parts.push(`${subs} subagente${subs > 1 ? 's' : ''}`)
    if (tools) parts.push(`${tools} tool${tools > 1 ? 's' : ''}`)
    return parts.length ? `${parts.join(' + ')} rodando` : `${run.length} rodando`
  }
  if (working) return 'pensando…'
  if (a.lastFinished) return withDetail(a.lastFinished)
  return ''
}
