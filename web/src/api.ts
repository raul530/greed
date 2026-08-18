import type {
  BtwExchange,
  InsightsReport,
  MsgAttachment,
  Project,
  SessionMeta,
  UsageSnapshot,
} from '../../shared/types'

export interface SlashCmd {
  name: string
  description: string
  argumentHint: string
  source: 'sdk' | 'greed'
}

async function j<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

/** POST dos bytes crus de um arquivo; devolve o caminho relativo e o absoluto. */
async function upload(url: string, file: File): Promise<{ path: string; abs: string }> {
  const res = await fetch(`${url}?name=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `HTTP ${res.status}`)
  }
  return res.json() as Promise<{ path: string; abs: string }>
}

export interface BrowseResult {
  path: string
  parent: string | null
  isRepo: boolean
  entries: { name: string; isRepo: boolean }[]
}

export const api = {
  browse: (dir?: string) =>
    j<BrowseResult>(`/api/browse${dir ? `?path=${encodeURIComponent(dir)}` : ''}`),
  addProject: (name: string, path: string) =>
    j<Project>('/api/projects', { method: 'POST', body: JSON.stringify({ name, path }) }),
  removeProject: (id: string) =>
    j<{ ok: true }>(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  newSession: (
    projectId: string,
    prompt: string,
    model: string | null,
    effort: string | null,
    permissionMode: string,
    codebasePath: string | null,
    attachments: MsgAttachment[] = [],
  ) =>
    j<SessionMeta>('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({
        projectId,
        prompt,
        model,
        effort,
        permissionMode,
        codebasePath,
        attachments,
      }),
    }),
  closeSession: (id: string) =>
    j<{ ok: true }>(`/api/sessions/${encodeURIComponent(id)}/close`, { method: 'POST' }),
  reopenSession: (id: string) =>
    j<{ ok: true }>(`/api/sessions/${encodeURIComponent(id)}/reopen`, { method: 'POST' }),
  // slash commands que valem nesta sessão (Claude Code + os do Greed)
  sessionCommands: (sessionId: string) =>
    j<{ commands: SlashCmd[]; btw: BtwExchange[] }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/commands`,
    ),
  // html que o agente escreveu na pasta de trabalho, mais recente primeiro
  previewFiles: (sessionId: string) =>
    j<{ files: { rel: string; mtime: number }[] }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/preview`,
    ),
  // força uma leitura do consumo agora (o servidor também empurra por WS a cada 30s)
  refreshUsage: () => j<UsageSnapshot>('/api/usage'),
  // de onde saiu o consumo, lido dos transcripts locais
  insights: (hours: number) => j<InsightsReport>(`/api/insights?hours=${hours}`),
  uploadAttachment: (sessionId: string, file: File) =>
    upload(`/api/sessions/${encodeURIComponent(sessionId)}/attachments`, file),
  // anexo antes da sessão existir (modal de novo chat): vai direto pro projeto
  uploadProjectAttachment: (projectId: string, file: File) =>
    upload(`/api/projects/${encodeURIComponent(projectId)}/attachments`, file),
}
