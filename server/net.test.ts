import { describe, expect, it } from 'vitest'
import { createHostGuard, isLoopbackAddress, normalizeHostname, parseAllowedHosts } from './net'

// guarda padrão: sem GREED_HOST nem GREED_ALLOWED_HOSTS — o comportamento de hoje
const padrao = createHostGuard()
// guarda de rede: bind num IP de tailnet + um nome de MagicDNS na lista
const rede = createHostGuard({
  bindHost: '100.64.0.7',
  allowedHosts: 'mac.ts.net',
})

describe('normalizeHostname', () => {
  it('tira porta, colchetes e caixa', () => {
    expect(normalizeHostname('MAC.TS.NET:4517')).toBe('mac.ts.net')
    expect(normalizeHostname('localhost')).toBe('localhost')
    expect(normalizeHostname('[::1]:4517')).toBe('::1')
    expect(normalizeHostname('[fd7a:115c:a1e0::ab12]:4517')).toBe('fd7a:115c:a1e0::ab12')
    expect(normalizeHostname('::1')).toBe('::1')
  })
  it('ponto final de FQDN é o mesmo nome', () => {
    expect(normalizeHostname('mac.ts.net.')).toBe('mac.ts.net')
    expect(normalizeHostname('mac.ts.net.:4517')).toBe('mac.ts.net')
  })
  it('vazio ou ilegível vira null', () => {
    expect(normalizeHostname(undefined)).toBeNull()
    expect(normalizeHostname('')).toBeNull()
    expect(normalizeHostname('   ')).toBeNull()
    expect(normalizeHostname('[::1')).toBeNull() // colchete sem fechar
    expect(normalizeHostname('localhost:')).toBeNull() // porta não numérica
    expect(normalizeHostname('localhost:abc')).toBeNull()
  })
})

describe('parseAllowedHosts', () => {
  it('aceita vírgula, espaço e espaço perdido', () => {
    expect(parseAllowedHosts(undefined)).toEqual([])
    expect(parseAllowedHosts('')).toEqual([])
    expect(parseAllowedHosts('mac.ts.net')).toEqual(['mac.ts.net'])
    expect(parseAllowedHosts('mac.ts.net,outro.local')).toEqual(['mac.ts.net', 'outro.local'])
    expect(parseAllowedHosts('mac.ts.net outro.local')).toEqual(['mac.ts.net', 'outro.local'])
    expect(parseAllowedHosts('  mac.ts.net ,  outro.local  ')).toEqual(['mac.ts.net', 'outro.local'])
  })
  it('entrada colada com porta ou esquema fica só o hostname', () => {
    expect(parseAllowedHosts('mac.ts.net:4517')).toEqual(['mac.ts.net'])
    expect(parseAllowedHosts('https://mac.ts.net')).toEqual(['mac.ts.net'])
    expect(parseAllowedHosts('http://mac.ts.net:4517/coisa')).toEqual(['mac.ts.net'])
  })
  it('normaliza caixa e repetição', () => {
    expect(parseAllowedHosts('MAC.TS.NET, mac.ts.net')).toEqual(['mac.ts.net'])
  })
})

describe('isLoopbackAddress', () => {
  it('loopback de verdade', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('127.0.0.5')).toBe(true) // 127/8 inteiro
    expect(isLoopbackAddress('localhost')).toBe(true)
    expect(isLoopbackAddress('::1')).toBe(true)
  })
  it('curinga e endereços de rede não são loopback', () => {
    expect(isLoopbackAddress('0.0.0.0')).toBe(false)
    expect(isLoopbackAddress('::')).toBe(false)
    expect(isLoopbackAddress('100.64.0.7')).toBe(false)
    expect(isLoopbackAddress('192.168.1.20')).toBe(false)
    expect(isLoopbackAddress('mac.ts.net')).toBe(false)
  })
})

describe('guarda padrão (loopback) — o comportamento de hoje, sem env', () => {
  it('escuta em 127.0.0.1 e não exige cabeçalhos', () => {
    expect(padrao.bindHost).toBe('127.0.0.1')
    expect(padrao.requireHeaders).toBe(false)
  })
  it('só os nomes locais passam, com ou sem porta', () => {
    expect(padrao.allowsHost('localhost')).toBe(true)
    expect(padrao.allowsHost('localhost:4517')).toBe(true)
    expect(padrao.allowsHost('127.0.0.1:4517')).toBe(true)
    expect(padrao.allowsHost('[::1]:4517')).toBe(true)
    expect(padrao.allowsHost('::1')).toBe(true)
    expect(padrao.allowsHost('LOCALHOST')).toBe(true)
  })
  it('sem Host continua ok (ferramentas locais)', () => {
    expect(padrao.allowsHost(undefined)).toBe(true)
    expect(padrao.allowsHost('')).toBe(true)
    expect(padrao.allowsHost('   ')).toBe(true)
  })
  it('parecido não é igual', () => {
    expect(padrao.allowsHost('notlocalhost')).toBe(false)
    expect(padrao.allowsHost('localhost.evil.com')).toBe(false)
    expect(padrao.allowsHost('evil-localhost')).toBe(false)
    expect(padrao.allowsHost('mac.ts.net')).toBe(false) // sem allowlist, nome de rede não entra
  })
  it('Origin local passa, ausente passa, o resto não', () => {
    expect(padrao.allowsOrigin('http://localhost:5173')).toBe(true)
    expect(padrao.allowsOrigin('http://127.0.0.1:4517')).toBe(true)
    expect(padrao.allowsOrigin(undefined)).toBe(true)
    expect(padrao.allowsOrigin('http://evil.com')).toBe(false)
    expect(padrao.allowsOrigin('null')).toBe(false) // iframe sandbox: Origin real, não ausência
    expect(padrao.allowsOrigin('isso não é uma url')).toBe(false)
  })
})

describe('guarda de rede (bind fora do loopback)', () => {
  it('exige os cabeçalhos', () => {
    expect(rede.requireHeaders).toBe(true)
    expect(rede.allowsHost(undefined)).toBe(false)
    expect(rede.allowsHost('')).toBe(false)
    expect(rede.allowsHost('   ')).toBe(false)
    expect(rede.allowsOrigin(undefined)).toBe(false)
    expect(rede.allowsOrigin('')).toBe(false)
  })
  it('nome da lista passa: exato, com porta, noutra caixa, com ponto final', () => {
    expect(rede.allowsHost('mac.ts.net')).toBe(true)
    expect(rede.allowsHost('mac.ts.net:4517')).toBe(true)
    expect(rede.allowsHost('MAC.TS.NET')).toBe(true)
    expect(rede.allowsHost('mac.ts.net.')).toBe(true)
    expect(rede.allowsHost('mac.ts.net.:4517')).toBe(true)
  })
  it('o endereço do bind e o loopback continuam valendo', () => {
    expect(rede.allowsHost('100.64.0.7:4517')).toBe(true)
    expect(rede.allowsHost('localhost:4517')).toBe(true)
    expect(rede.allowsHost('[::1]:4517')).toBe(true)
  })
  it('sufixo, prefixo e substring são ataques, não matches', () => {
    expect(rede.allowsHost('mac.ts.net.evil.com')).toBe(false)
    expect(rede.allowsHost('evil-mac.ts.net')).toBe(false)
    expect(rede.allowsHost('xmac.ts.net')).toBe(false)
    expect(rede.allowsHost('mac.ts.ne')).toBe(false)
    expect(rede.allowsHost('amac.ts.netz')).toBe(false) // nome da lista como substring
    expect(rede.allowsHost('sub.mac.ts.net')).toBe(false) // nada de curinga implícito
  })
  it('IPv6 do tailnet entra na lista e casa com colchetes e porta', () => {
    const g = createHostGuard({
      bindHost: 'fd7a:115c:a1e0::ab12',
      allowedHosts: 'mac.ts.net',
    })
    expect(g.allowsHost('[fd7a:115c:a1e0::ab12]:4517')).toBe(true)
    expect(g.allowsHost('[FD7A:115C:A1E0::AB12]:4517')).toBe(true)
    expect(g.allowsHost('[fd7a:115c:a1e0::dead]:4517')).toBe(false)
  })
  it('Origin segue a mesma lista, http e https', () => {
    expect(rede.allowsOrigin('http://mac.ts.net:5173')).toBe(true)
    expect(rede.allowsOrigin('https://mac.ts.net')).toBe(true)
    expect(rede.allowsOrigin('http://100.64.0.7:4517')).toBe(true)
    expect(rede.allowsOrigin('http://mac.ts.net.evil.com')).toBe(false)
    expect(rede.allowsOrigin('null')).toBe(false)
    expect(rede.allowsOrigin('isso não é uma url')).toBe(false)
  })
  it('bind curinga (0.0.0.0) não vira Host aceito', () => {
    const g = createHostGuard({ bindHost: '0.0.0.0', allowedHosts: 'mac.ts.net' })
    expect(g.requireHeaders).toBe(true)
    expect(g.allowsHost('0.0.0.0:4517')).toBe(false)
    expect(g.allowsHost('mac.ts.net:4517')).toBe(true)
  })
})
