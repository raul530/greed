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

function writeJson(file: string, value: unknown, indent = 2): void {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, indent))
  fs.renameSync(tmp, file)
}

/**
 * Transcript é reescrito inteiro a cada gravação, e chat longo passa de 10 MB:
 * por isso a gravação junta tudo que mudou em 1 s, e sai sem indentação.
 * Encerrar o servidor grava na hora (flush), então só uma morte à força
 * (kill -9, falta de luz) perde esse último segundo.
 */
const FLUSH_MS = 1000
const pendingTranscripts = new Map<string, TranscriptEntry[]>()
let flushTimer: NodeJS.Timeout | null = null

function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    flushTranscripts()
  }, FLUSH_MS)
}

function flushTranscripts(): void {
  for (const [id, entries] of pendingTranscripts) {
    writeJson(path.join(TRANSCRIPTS_DIR, `${id}.json`), entries, 0)
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
  deleteTranscript(sessionId: string): void {
    pendingTranscripts.delete(sessionId)
    try {
      fs.unlinkSync(path.join(TRANSCRIPTS_DIR, `${sessionId}.json`))
    } catch {}
  },
  /** cache genérico em data/<name>.json (lista de comandos, por exemplo) */
  read<T>(name: string, fallback: T): T {
    return readJson<T>(path.join(DATA_DIR, `${name}.json`), fallback)
  },
  write(name: string, value: unknown): void {
    writeJson(path.join(DATA_DIR, `${name}.json`), value)
  },
  flush(): void {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    flushTranscripts()
  },
}
