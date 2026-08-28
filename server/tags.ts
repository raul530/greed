import { execFile, spawn } from 'node:child_process'

/**
 * Etiqueta do Finder nos arquivos que o agente cria (só macOS).
 *
 * A etiqueta mora no xattr com.apple.metadata:_kMDItemUserTags, um plist com
 * uma linha por etiqueta no formato "nome\ncor". Tem que ser plist *binário*:
 * com XML o Finder até lê, mas o Spotlight não indexa e a etiqueta não aparece
 * na busca. Escrever xattr mexe no ctime e não no mtime, então não atrapalha a
 * conta de quem escreveu o quê no preview.
 */
const KEY = 'com.apple.metadata:_kMDItemUserTags'
/** paleta do Finder: 0 sem cor, 5 amarelo */
const COLOR = 5
/** teto por turno: etiquetar é barato, mas não a ponto de valer um loop aberto */
const MAX_PER_TURN = 40

/** Nome da etiqueta; GREED_FINDER_TAG='' desliga o recurso. */
function tagName(): string {
  const custom = process.env.GREED_FINDER_TAG
  return custom === undefined ? 'greed' : custom.trim()
}

function enabled(): boolean {
  return process.platform === 'darwin' && tagName().length > 0
}

/** Roda um comando com entrada no stdin e devolve o stdout. */
function pipe(cmd: string, args: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args)
    const out: Buffer[] = []
    child.stdout.on('data', (b: Buffer) => out.push(b))
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`${cmd} saiu ${code}`)),
    )
    child.stdin.on('error', () => {}) // processo pode fechar a entrada antes da gente
    if (input) child.stdin.end(input)
    else child.stdin.end()
  })
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Etiquetas atuais do arquivo. Sem xattr (o normal num arquivo novo) devolve []. */
async function readTags(file: string): Promise<string[]> {
  let hex: Buffer
  try {
    hex = await pipe('xattr', ['-px', KEY, file])
  } catch {
    return [] // sem etiqueta nenhuma, ou o volume não guarda xattr
  }
  try {
    const raw = Buffer.from(hex.toString().replace(/\s+/g, ''), 'hex')
    const json = await pipe('plutil', ['-convert', 'json', '-o', '-', '-'], raw)
    const parsed: unknown = JSON.parse(json.toString())
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : []
  } catch {
    return []
  }
}

/** Converte a lista de etiquetas no hex do plist binário que o xattr aceita. */
async function tagsToHex(tags: string[]): Promise<string> {
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><array>' +
    tags.map((t) => `<string>${escapeXml(t)}</string>`).join('') +
    '</array></plist>'
  const bin = await pipe('plutil', ['-convert', 'binary1', '-', '-o', '-'], Buffer.from(xml, 'utf8'))
  return bin.toString('hex')
}

function write(file: string, hex: string): Promise<void> {
  return new Promise((resolve) => {
    execFile('xattr', ['-wx', KEY, hex, file], () => resolve()) // falhou, paciência
  })
}

/**
 * Marca os arquivos com a etiqueta do Greed, preservando as que já existem.
 * Best effort: fora do macOS não faz nada e nenhum erro sobe pro turno.
 */
export async function tagAsGreed(files: string[]): Promise<void> {
  if (!enabled() || files.length === 0) return
  const mine = `${tagName()}\n${COLOR}`
  let onlyMine: string | null = null // hex do caso comum (arquivo novo, sem etiqueta)
  for (const file of files.slice(0, MAX_PER_TURN)) {
    try {
      const current = await readTags(file)
      if (current.some((t) => t.split('\n')[0] === tagName())) continue
      if (current.length === 0) {
        onlyMine = onlyMine ?? (await tagsToHex([mine]))
        await write(file, onlyMine)
      } else {
        await write(file, await tagsToHex([...current, mine]))
      }
    } catch {
      // um arquivo que não deu pra etiquetar não pode derrubar o resto
    }
  }
}
