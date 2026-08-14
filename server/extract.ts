import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

// Extração de texto 100% nativa do macOS — sem dependências npm/pip, sem tokens.
// PDF via osascript+PDFKit; docx/rtf/odt via textutil; xlsx/pptx via python3 stdlib.

const exec = promisify(execFile)
const OOXML = fileURLToPath(new URL('./extract/ooxml.py', import.meta.url))
const EXEC_OPTS = { timeout: 60_000, maxBuffer: 32 * 1024 * 1024 }

const TEXTUAL = new Set([
  'md', 'markdown', 'txt', 'text', 'csv', 'tsv', 'json', 'yaml', 'yml', 'xml',
  'html', 'htm', 'log', 'rst', 'ini', 'toml', 'conf', 'cfg', 'properties',
])

// JXA + Quartz: extrai a camada de texto do PDF (vazio se for PDF escaneado)
const JXA =
  'ObjC.import("Quartz");function run(argv){var d=$.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0]));return d.isNil()?"":ObjC.unwrap(d.string);}'

async function run(cmd: string, args: string[]): Promise<{ ok: boolean; text: string }> {
  try {
    const { stdout } = await exec(cmd, args, EXEC_OPTS)
    const text = stdout.trim()
    return text ? { ok: true, text } : { ok: false, text: '' }
  } catch {
    return { ok: false, text: '' }
  }
}

export async function extractText(
  absPath: string,
  format: string,
): Promise<{ ok: boolean; text: string }> {
  const fmt = format.toLowerCase()
  try {
    if (TEXTUAL.has(fmt)) {
      const text = fs.readFileSync(absPath, 'utf8')
      return text.trim() ? { ok: true, text } : { ok: false, text: '' }
    }
    if (fmt === 'pdf') return run('osascript', ['-l', 'JavaScript', '-e', JXA, absPath])
    if (['docx', 'doc', 'odt', 'rtf'].includes(fmt)) {
      return run('textutil', ['-convert', 'txt', absPath, '-stdout'])
    }
    if (['xlsx', 'xlsm', 'xltx'].includes(fmt)) return run('python3', [OOXML, 'xlsx', absPath])
    if (['pptx', 'potx'].includes(fmt)) return run('python3', [OOXML, 'pptx', absPath])
    return { ok: false, text: '' }
  } catch {
    return { ok: false, text: '' }
  }
}
