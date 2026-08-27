import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import type { ClaudeThread, TranscriptEntry } from '../shared/types'
import { listProfiles } from './profiles'
import { summarizeToolInput, truncate, uid } from './util'

const HEAD_BYTES = 96 * 1024
const MAX_ENTRIES = 300
const TITLE_MAX = 90
const PREVIEW_MAX = 220

function projectDirs(profileDir: string): string[] {
  const root = path.join(profileDir, 'projects')
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('-'))
      .map((e) => path.join(root, e.name))
  } catch {
    return []
  }
}

function readHead(file: string): Record<string, unknown>[] {
  let fd: number | null = null
  try {
    fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(HEAD_BYTES)
    const read = fs.readSync(fd, buf, 0, HEAD_BYTES, 0)
    const lines = buf.subarray(0, read).toString('utf8').split('\n')
    if (read === HEAD_BYTES) lines.pop()
    const out: Record<string, unknown>[] = []
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line) as Record<string, unknown>)
      } catch {
        continue
      }
    }
    return out
  } catch {
    return []
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is { type: string; text: string } => {
      const block = b as { type?: string; text?: unknown }
      return block.type === 'text' && typeof block.text === 'string'
    })
    .map((b) => b.text)
    .join('\n')
    .trim()
}

function isNoise(text: string): boolean {
  return !text || text.startsWith('<system-reminder>') || text.startsWith('<command-name>')
}

function describe(head: Record<string, unknown>[]): Omit<ClaudeThread, 'id' | 'profile' | 'updatedAt'> {
  let cwd = ''
  let title = ''
  let preview = ''
  let firstUser = ''
  for (const d of head) {
    if (!cwd && typeof d.cwd === 'string') cwd = d.cwd
    if (!title && typeof d.customTitle === 'string') title = d.customTitle
    if (!title && typeof d.agentName === 'string') title = d.agentName
    if (!preview && typeof d.lastPrompt === 'string') preview = d.lastPrompt
    if (!firstUser && d.type === 'user' && !d.isMeta && !d.isSidechain) {
      const text = textOf((d.message as { content?: unknown } | undefined)?.content)
      if (!isNoise(text)) firstUser = text
    }
  }
  return {
    cwd,
    title: truncate(title || firstUser || '(sem título)', TITLE_MAX),
    preview: truncate(preview || firstUser, PREVIEW_MAX),
  }
}

export function listThreads(profileDir: string | null, limit: number): ClaudeThread[] {
  const profiles = listProfiles().filter((p) => !profileDir || p.dir === profileDir)
  const files: { file: string; profile: string; updatedAt: number }[] = []
  for (const profile of profiles) {
    for (const dir of projectDirs(profile.dir)) {
      let names: string[] = []
      try {
        names = fs.readdirSync(dir)
      } catch {
        continue
      }
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue
        try {
          files.push({
            file: path.join(dir, name),
            profile: profile.dir,
            updatedAt: fs.statSync(path.join(dir, name)).mtimeMs,
          })
        } catch {
          continue
        }
      }
    }
  }
  const seen = new Set<string>()
  const unique = files.filter((f) => {
    let real = f.file
    try {
      real = fs.realpathSync(f.file)
    } catch {}
    if (seen.has(real)) return false
    seen.add(real)
    return true
  })
  unique.sort((a, b) => b.updatedAt - a.updatedAt)
  return unique.slice(0, limit).map((f) => ({
    id: path.basename(f.file, '.jsonl'),
    profile: f.profile,
    updatedAt: Math.round(f.updatedAt),
    ...describe(readHead(f.file)),
  }))
}

export function describeThread(file: string): { cwd: string; title: string; preview: string } {
  return describe(readHead(file))
}

export function findThreadFile(profileDir: string, threadId: string): string | null {
  if (!/^[\w-]+$/.test(threadId)) return null
  for (const dir of projectDirs(profileDir)) {
    const file = path.join(dir, `${threadId}.jsonl`)
    if (fs.existsSync(file)) return file
  }
  return null
}

function entriesFor(raw: Record<string, unknown>, ts: number): TranscriptEntry[] {
  if (raw.isSidechain || raw.isMeta) return []
  const message = raw.message as { content?: unknown } | undefined
  if (raw.type === 'user') {
    const text = textOf(message?.content)
    return isNoise(text) ? [] : [{ kind: 'user', id: uid(), text, ts }]
  }
  if (raw.type !== 'assistant' || !Array.isArray(message?.content)) return []
  const out: TranscriptEntry[] = []
  const text = textOf(message?.content)
  if (text) out.push({ kind: 'assistant', id: uid(), text, ts })
  for (const block of message?.content as { type?: string; name?: string; input?: unknown }[]) {
    if (block.type !== 'tool_use' || !block.name) continue
    out.push({
      kind: 'tool',
      id: uid(),
      name: block.name,
      summary: summarizeToolInput(block.name, block.input),
      status: 'done',
      ts,
    })
  }
  return out
}

export async function readThreadEntries(file: string): Promise<TranscriptEntry[]> {
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })
  const out: TranscriptEntry[] = []
  for await (const line of rl) {
    if (!line.trim()) continue
    let raw: Record<string, unknown>
    try {
      raw = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const ts = Date.parse(String(raw.timestamp ?? '')) || Date.now()
    for (const entry of entriesFor(raw, ts)) {
      out.push(entry)
      if (out.length > MAX_ENTRIES) out.shift()
    }
  }
  return out
}
