/**
 * Quem pode falar com o servidor: casamento de Host e Origin com a lista de
 * nomes permitidos. Tudo aqui é função pura — index.ts monta o guarda uma vez
 * no boot e os testes chamam direto, sem subir servidor.
 *
 * O que isto é (e o que não é): a checagem de Host barra DNS rebinding no
 * navegador, e a de Origin barra hijacking cross-site do WebSocket. Nenhuma
 * das duas é autenticação — quem alcança o endereço do bind fala com o
 * servidor. Por isso o padrão é 127.0.0.1, e abrir pra rede (GREED_HOST) é
 * decisão explícita de quem roda.
 */

/** nomes de loopback sempre aceitos, com ou sem GREED_ALLOWED_HOSTS */
const LOOPBACK_NAMES = ['localhost', '127.0.0.1', '::1'] as const

/**
 * Extrai o hostname de um valor de Host (ou de um hostname de URL): tira a
 * porta, os colchetes de IPv6 e o ponto final de FQDN, e põe em minúsculas.
 * Devolve null quando não dá pra ler um nome — o chamador decide se "não veio
 * nada" e "veio lixo" são casos diferentes.
 */
export function normalizeHostname(raw: string | null | undefined): string | null {
  if (raw == null) return null
  let s = raw.trim()
  if (s === '') return null
  if (s.startsWith('[')) {
    // IPv6 com colchetes: [::1] ou [::1]:4517
    const end = s.indexOf(']')
    if (end < 0) return null
    const rest = s.slice(end + 1)
    if (rest !== '' && !/^:\d+$/.test(rest)) return null
    const inner = s.slice(1, end)
    return inner === '' ? null : inner.toLowerCase()
  }
  // sem colchetes, dois ou mais ':' só podem ser um literal IPv6 cru (ex.: ::1)
  const first = s.indexOf(':')
  if (first >= 0 && s.indexOf(':', first + 1) >= 0) return s.toLowerCase()
  s = s.replace(/:\d+$/, '')
  if (s.includes(':')) return null // sobrou ':' sem porta numérica
  if (s.endsWith('.') && s.length > 1) s = s.slice(0, -1) // FQDN absoluto: mac.ts.net. == mac.ts.net
  return s === '' ? null : s.toLowerCase()
}

/**
 * Lê GREED_ALLOWED_HOSTS: nomes separados por vírgula e/ou espaço. Entrada
 * colada com esquema, porta ou caminho é tolerada — fica só o hostname.
 * O casamento depois é sempre por igualdade exata do nome normalizado.
 */
export function parseAllowedHosts(raw: string | null | undefined): string[] {
  if (!raw) return []
  const out: string[] = []
  for (const piece of raw.split(/[\s,]+/)) {
    let entry = piece.trim()
    if (!entry) continue
    entry = entry.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '') // "https://mac.ts.net" → "mac.ts.net"
    const slash = entry.indexOf('/')
    if (slash >= 0) entry = entry.slice(0, slash)
    const name = normalizeHostname(entry)
    if (name && !out.includes(name)) out.push(name)
  }
  return out
}

/** O endereço de bind é loopback? Fora dele, Host e Origin viram obrigatórios. */
export function isLoopbackAddress(host: string): boolean {
  const name = normalizeHostname(host)
  if (!name) return false
  if (name === 'localhost' || name === '::1') return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name) // 127.0.0.0/8 inteiro
}

export interface HostGuard {
  /** endereço que o listen deve usar (GREED_HOST, padrão 127.0.0.1) */
  bindHost: string
  /** fora do loopback, requisição sem Host e handshake sem Origin são recusados */
  requireHeaders: boolean
  /** nomes aceitos, já normalizados: loopback + bind + GREED_ALLOWED_HOSTS */
  allowedHosts: ReadonlySet<string>
  allowsHost(host: string | undefined): boolean
  allowsOrigin(origin: string | undefined): boolean
}

export function createHostGuard(opts: {
  bindHost?: string | null
  allowedHosts?: string | null
} = {}): HostGuard {
  const bindHost = opts.bindHost?.trim() || '127.0.0.1'
  const requireHeaders = !isLoopbackAddress(bindHost)

  const allowed = new Set<string>(LOOPBACK_NAMES)
  // o próprio endereço do bind vale como Host: quem sobe em 100.x.y.z abre por 100.x.y.z
  const bindName = normalizeHostname(bindHost)
  if (bindName && bindName !== '0.0.0.0' && bindName !== '::') allowed.add(bindName)
  for (const name of parseAllowedHosts(opts.allowedHosts)) allowed.add(name)

  const allowsHost = (host: string | undefined): boolean => {
    // sem Host (ferramentas locais, HTTP/1.0): ok no loopback, recusado fora dele
    if (host === undefined || host.trim() === '') return !requireHeaders
    const name = normalizeHostname(host)
    return name !== null && allowed.has(name)
  }

  const allowsOrigin = (origin: string | undefined): boolean => {
    // sem Origin (cliente que não é navegador): ok no loopback, recusado fora dele.
    // "null" literal (iframe sandbox) NÃO é ausência — cai no parse e é recusado.
    if (origin === undefined || origin.trim() === '') return !requireHeaders
    try {
      const name = normalizeHostname(new URL(origin).hostname)
      return name !== null && allowed.has(name)
    } catch {
      return false
    }
  }

  return { bindHost, requireHeaders, allowedHosts: allowed, allowsHost, allowsOrigin }
}
