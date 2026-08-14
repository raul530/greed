import type { Project, SessionMeta } from '../../shared/types'

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

export const api = {
  addProject: (name: string, path: string) =>
    j<Project>('/api/projects', { method: 'POST', body: JSON.stringify({ name, path }) }),
  removeProject: (id: string) =>
    j<{ ok: true }>(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  newSession: (projectId: string, prompt: string, model: string | null) =>
    j<SessionMeta>('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ projectId, prompt, model }),
    }),
  closeSession: (id: string) =>
    j<{ ok: true }>(`/api/sessions/${encodeURIComponent(id)}/close`, { method: 'POST' }),
  reopenSession: (id: string) =>
    j<{ ok: true }>(`/api/sessions/${encodeURIComponent(id)}/reopen`, { method: 'POST' }),
}
