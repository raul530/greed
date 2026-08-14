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
