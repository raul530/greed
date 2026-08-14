import fs from 'node:fs'
import path from 'node:path'
import type { Project, SessionMeta, TranscriptEntry } from '../shared/types'

const DATA_DIR = path.join(process.cwd(), 'data')
const TRANSCRIPTS_DIR = path.join(DATA_DIR, 'transcripts')
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json')
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json')

fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true })

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

function writeJson(file: string, value: unknown): void {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2))
  fs.renameSync(tmp, file)
}

const pendingTranscripts = new Map<string, TranscriptEntry[]>()
let flushTimer: NodeJS.Timeout | null = null

function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    flushTranscripts()
  }, 250)
}

function flushTranscripts(): void {
  for (const [id, entries] of pendingTranscripts) {
    writeJson(path.join(TRANSCRIPTS_DIR, `${id}.json`), entries)
  }
  pendingTranscripts.clear()
}

export const store = {
  loadProjects(): Project[] {
    return readJson<Project[]>(PROJECTS_FILE, [])
  },
  saveProjects(projects: Project[]): void {
    writeJson(PROJECTS_FILE, projects)
  },
  loadSessions(): SessionMeta[] {
    return readJson<SessionMeta[]>(SESSIONS_FILE, [])
  },
  saveSessions(sessions: SessionMeta[]): void {
    writeJson(SESSIONS_FILE, sessions)
  },
  loadTranscript(sessionId: string): TranscriptEntry[] {
    const pending = pendingTranscripts.get(sessionId)
    if (pending) return pending
    return readJson<TranscriptEntry[]>(path.join(TRANSCRIPTS_DIR, `${sessionId}.json`), [])
  },
  saveTranscript(sessionId: string, entries: TranscriptEntry[]): void {
    pendingTranscripts.set(sessionId, entries)
    scheduleFlush()
  },
  flush(): void {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    flushTranscripts()
  },
}
