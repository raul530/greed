import fs from 'node:fs'
import path from 'node:path'

// Pastas que nunca interessam no preview (e que fariam a varredura custar caro).
const PREVIEW_SKIP = new Set(['node_modules', '.git', '.next', 'coverage', 'venv', '_texto'])
const PREVIEW_DEPTH = 3
export const PREVIEW_MAX = 40
// teto da varredura por pasta: o corte final é por mtime, não por ordem de disco
const PREVIEW_SCAN_MAX = 400

// Entregáveis: o que ele produz pra gente ver ou baixar. Fora daqui é código de
// apoio (css/js), que o html referencia sozinho e não precisa aparecer na lista.
export const PREVIEW_EXT = /\.(html?|md|markdown|svg|pdf|csv|txt)$/i

export interface PreviewEntry {
  rel: string
  mtime: number
  /** índice da pasta em previewRootsForSession — vai na URL pra achar o arquivo de volta */
  root: number
  /** caminho absoluto, só do lado do servidor (não vai pro cliente) */
  abs?: string
}

/** Lista os entregáveis de uma pasta. Varredura rasa, limitada e sem ordem garantida. */
export function findFiles(root: string, index: number): PreviewEntry[] {
  const out: PreviewEntry[] = []
  const walk = (dir: string, depth: number) => {
    if (depth > PREVIEW_DEPTH || out.length >= PREVIEW_SCAN_MAX) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (out.length >= PREVIEW_SCAN_MAX) return
      if (e.name.startsWith('.') && e.name !== '.') continue
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (!PREVIEW_SKIP.has(e.name)) walk(abs, depth + 1)
      } else if (PREVIEW_EXT.test(e.name)) {
        try {
          out.push({
            rel: path.relative(root, abs),
            mtime: fs.statSync(abs).mtimeMs,
            root: index,
            abs,
          })
        } catch {
          // arquivo sumiu no meio da varredura
        }
      }
    }
  }
  walk(root, 0)
  return out
}

/** Entregáveis de todas as pastas da sessão, mais recente primeiro. */
export function findAllFiles(roots: string[]): PreviewEntry[] {
  return roots.flatMap((root, i) => findFiles(root, i)).sort((a, b) => b.mtime - a.mtime)
}
