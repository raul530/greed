// Limiar para embutir o conteúdo do arquivo direto na mensagem (inline).
// Acima disso, ou se for binário, o arquivo é salvo na pasta do projeto.
export const INLINE_MAX = 64 * 1024

const TEXT_EXT = new Set([
  'md', 'markdown', 'txt', 'text', 'csv', 'tsv', 'json', 'yaml', 'yml', 'xml',
  'html', 'htm', 'css', 'js', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java',
  'c', 'h', 'cpp', 'cc', 'sh', 'bash', 'zsh', 'sql', 'log', 'ini', 'toml', 'env',
  'conf', 'cfg', 'properties', 'gradle', 'rst',
])

const TEXT_MIME = new Set([
  'application/json',
  'application/xml',
  'application/x-yaml',
  'application/javascript',
  'application/x-sh',
])

export function isTextFile(file: File): boolean {
  if (file.type.startsWith('text/')) return true
  if (TEXT_MIME.has(file.type)) return true
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  return TEXT_EXT.has(ext)
}

/** Decide se o arquivo deve ir inline (texto pequeno) ou salvo na pasta. */
export function shouldInline(file: File): boolean {
  return isTextFile(file) && file.size <= INLINE_MAX
}

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
}

export function extFromMime(type: string): string {
  return MIME_EXT[type] ?? (type.split('/')[1] || 'bin')
}

/** Extrai arquivos coláveis do clipboard (imagens de print/cópia), com nome único. */
export function filesFromClipboard(dt: DataTransfer): File[] {
  const raw: File[] = [...(dt.files ?? [])]
  if (raw.length === 0) {
    for (const item of [...(dt.items ?? [])]) {
      if (item.kind === 'file') {
        const f = item.getAsFile()
        if (f) raw.push(f)
      }
    }
  }
  const stamp = Date.now()
  return raw.map((f, i) => {
    const generic = !f.name || /^image\.\w+$/i.test(f.name)
    const name = generic ? `colado-${stamp}-${i}.${extFromMime(f.type)}` : f.name
    return generic ? new File([f], name, { type: f.type }) : f
  })
}
