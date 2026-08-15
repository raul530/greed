import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { extractText } from './extract'
import { now, truncate, uid } from './util'

// Base de conhecimento de documentos POR PROJETO. Cada anexo é persistido,
// tem o texto extraído (nativo, sem custo) e uma descrição de 1 linha (Haiku).
// Um catálogo compacto é injetado no system prompt de toda sessão do projeto,
// então o agente sempre sabe o que existe e abre o original/texto sob demanda.

const DOCS_DIR = path.join(process.cwd(), 'data', 'docs')
fs.mkdirSync(DOCS_DIR, { recursive: true })

const MAX_DOCS = 500
const CATALOG_INJECT_MAX = 40

export interface DocMeta {
  id: string
  name: string
  relPath: string // 'greed-anexos/<name>'
  textRelPath: string | null // 'greed-anexos/_texto/<id>.txt' | null
  format: string
  size: number
  hash: string
  description: string
  status: 'ready' | 'failed'
  addedAt: number
  sessionId: string
}

function fileFor(projectId: string): string {
  return path.join(DOCS_DIR, `${projectId}.json`)
}

function load(projectId: string): DocMeta[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(fileFor(projectId), 'utf8'))
    return Array.isArray(parsed) ? (parsed as DocMeta[]) : []
  } catch {
    return []
  }
}

function save(projectId: string, docs: DocMeta[]): void {
  const file = fileFor(projectId)
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(docs, null, 2))
  fs.renameSync(tmp, file)
}

// serializa a ingestão por projeto (dois anexos ao mesmo tempo não se atropelam)
const chains = new Map<string, Promise<void>>()
function enqueue(projectId: string, task: () => Promise<void>): Promise<void> {
  const prev = chains.get(projectId) ?? Promise.resolve()
  const next = prev.then(task).catch((err) => console.error('[greed] docs:', err))
  chains.set(projectId, next)
  return next
}

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

/** Gera uma descrição curta do documento via Haiku (barato). '' em qualquer falha. */
async function describe(name: string, format: string, sample: string): Promise<string> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), 30_000)
  try {
    const q = query({
      prompt:
        'Descreva em UMA linha curta (máximo 15 palavras, no mesmo idioma do conteúdo, sem aspas e ' +
        'sem ponto final) o que é este documento, para um catálogo de acervo. Responda SÓ a descrição.\n\n' +
        `Nome: ${name} (${format})\nTrecho:\n${truncate(sample, 2000)}`,
      options: {
        cwd: os.tmpdir(),
        model: 'haiku',
        maxTurns: 1,
        tools: [],
        settingSources: [],
        systemPrompt: 'Você descreve documentos em uma linha para um catálogo. Responda apenas a descrição.',
        persistSession: false,
        abortController: abort,
        env: { ...process.env, ANTHROPIC_API_KEY: undefined },
      },
    })
    for await (const msg of q) {
      if (msg.type === 'result') {
        if (msg.subtype !== 'success') return ''
        const desc = msg.result.trim().replace(/^["'“”]+|["'“”.]+$/g, '')
        return desc ? truncate(desc, 160) : ''
      }
    }
    return ''
  } catch {
    return ''
  } finally {
    clearTimeout(timer)
  }
}

/** Regenera o índice completo (sem cap) em greed-anexos/INDEX.md — alvo de grep/leitura sob demanda. */
function writeIndexMd(projectPath: string, projectName: string, docs: DocMeta[]): void {
  const dir = path.join(projectPath, 'greed-anexos')
  fs.mkdirSync(dir, { recursive: true })
  const sorted = [...docs].sort((a, b) => b.addedAt - a.addedAt)
  let out = `# Base de conhecimento — ${projectName}\n\nGerado automaticamente pelo Greed. ${docs.length} documento(s).\n\n`
  for (const d of sorted) {
    out += `## ${d.name}\n`
    out += `- ${d.description || '(sem descrição)'}\n`
    out += `- formato: ${d.format} · status: ${d.status}\n`
    out += `- original: ./${d.relPath}\n`
    if (d.textRelPath) out += `- texto: ./${d.textRelPath}\n`
    out += '\n'
  }
  const tmp = path.join(dir, 'INDEX.md.tmp')
  fs.writeFileSync(tmp, out)
  fs.renameSync(tmp, path.join(dir, 'INDEX.md'))
}

/**
 * Ingesta um anexo na base de conhecimento do projeto. Fire-and-forget,
 * serializado por projeto. Dedup por hash (reanexar = 0 trabalho).
 */
export function ingestDoc(input: {
  projectId: string
  projectName: string
  projectPath: string
  sessionId: string
  name: string
  relPath: string
  bytes: Buffer
}): void {
  void enqueue(input.projectId, async () => {
    const hash = sha256(input.bytes)
    if (load(input.projectId).some((d) => d.hash === hash)) return

    const id = uid()
    const format = (input.name.split('.').pop() ?? '').toLowerCase()
    const abs = path.join(input.projectPath, input.relPath)
    const ex = await extractText(abs, format)

    let textRelPath: string | null = null
    if (ex.ok && ex.text.trim()) {
      const textDir = path.join(input.projectPath, 'greed-anexos', '_texto')
      fs.mkdirSync(textDir, { recursive: true })
      fs.writeFileSync(path.join(textDir, `${id}.txt`), ex.text)
      textRelPath = path.join('greed-anexos', '_texto', `${id}.txt`)
    }

    const description = textRelPath ? await describe(input.name, format, ex.text) : ''

    // recarrega (mudou durante os awaits) e refaz o dedup por corrida
    const docs = load(input.projectId)
    if (docs.some((d) => d.hash === hash)) return
    docs.push({
      id,
      name: input.name,
      relPath: input.relPath,
      textRelPath,
      format,
      size: input.bytes.length,
      hash,
      description,
      status: textRelPath ? 'ready' : 'failed',
      addedAt: now(),
      sessionId: input.sessionId,
    })
    const trimmed = docs.length > MAX_DOCS ? docs.slice(docs.length - MAX_DOCS) : docs
    save(input.projectId, trimmed)
    writeIndexMd(input.projectPath, input.projectName, trimmed)
  })
}

/** Catálogo compacto (1 linha/doc, cap 40) para injetar no system prompt. null se vazio.
 *  Usa caminhos absolutos (projectPath), então funciona mesmo quando o cwd é um codebase. */
export function renderDocCatalog(
  projectId: string,
  projectName: string,
  projectPath: string,
): string | null {
  const docs = load(projectId)
  if (docs.length === 0) return null
  const abs = (rel: string) => path.join(projectPath, rel)
  const shown = [...docs].sort((a, b) => b.addedAt - a.addedAt).slice(0, CATALOG_INJECT_MAX)
  let out = `# Base de conhecimento — documentos do projeto "${projectName}" (indexada pelo Greed)\n`
  out +=
    `${docs.length} documento(s). Para o conteúdo completo, use Read no caminho do original; ` +
    `para buscar por assunto no acervo, use Grep em ${abs('greed-anexos/_texto')}.\n`
  for (const d of shown) {
    const desc =
      d.description || (d.status === 'failed' ? 'sem texto extraído — abra o original' : 'documento')
    const textHint = d.textRelPath ? ` (texto: ${abs(d.textRelPath)})` : ''
    out += `- ${d.name} — ${desc} — ${abs(d.relPath)}${textHint}\n`
  }
  const rest = docs.length - shown.length
  if (rest > 0) {
    out += `- …e mais ${rest} documento(s); lista completa em ${abs('greed-anexos/INDEX.md')}.\n`
  }
  return out
}
