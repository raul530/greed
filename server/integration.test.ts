import { type ChildProcess, spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'

// Sobe o servidor de verdade (tsx server/index.ts) numa porta efêmera e bate
// nele por HTTP e WebSocket. O cwd é uma pasta descartável: data/ nasce lá.

const repo = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const tsxCli = path.join(repo, 'node_modules', 'tsx', 'dist', 'cli.mjs')

interface Booted {
  child: ChildProcess
  port: number
  cwd: string
  stop(): Promise<void>
}

async function boot(extraEnv: Record<string, string>, seed?: (cwd: string) => void): Promise<Booted> {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'greed-test-'))
  seed?.(cwd)
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.GREED_HOST
  delete env.GREED_ALLOWED_HOSTS
  delete env.GREED_SERVE_STATIC
  env.GREED_PORT = '0'
  Object.assign(env, extraEnv)
  const child = spawn(process.execPath, [tsxCli, path.join(repo, 'server', 'index.ts')], { cwd, env })
  let out = ''
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server não subiu:\n${out}`)), 30000)
    child.stdout?.on('data', (c: Buffer) => {
      out += c.toString()
      const m = out.match(/rodando em http:\/\/.*:(\d+)/)
      if (m) {
        clearTimeout(timer)
        resolve(Number(m[1]))
      }
    })
    child.stderr?.on('data', (c: Buffer) => {
      out += c.toString()
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`server morreu (${code}):\n${out}`))
    })
  })
  return {
    child,
    port,
    cwd,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve()
        child.on('exit', () => resolve())
        child.kill('SIGTERM')
        setTimeout(() => child.kill('SIGKILL'), 3000).unref()
      }),
  }
}

/** GET com o Host que a gente mandar — o de verdade, não o do socket */
function get(
  connectHost: string,
  port: number,
  reqPath: string,
  host?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: connectHost,
        port,
        path: reqPath,
        method: 'GET',
        setHost: host === undefined,
        headers: host === undefined ? {} : { Host: host },
      },
      (res) => {
        let body = ''
        res.on('data', (c: Buffer) => {
          body += c.toString()
        })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

/** requisição HTTP/1.0 crua, sem cabeçalho Host nenhum */
function getSemHost(connectHost: string, port: number, reqPath: string): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, connectHost, () => {
      sock.write(`GET ${reqPath} HTTP/1.0\r\n\r\n`)
    })
    let data = ''
    sock.on('data', (c: Buffer) => {
      data += c.toString()
    })
    sock.on('end', () => {
      const m = data.match(/^HTTP\/[\d.]+ (\d+)/)
      if (m) resolve({ status: Number(m[1]) })
      else reject(new Error(`resposta ilegível: ${data.slice(0, 120)}`))
    })
    sock.on('error', reject)
  })
}

/** tenta o handshake do WS; true = abriu, false = servidor recusou */
function wsAbre(url: string, origin?: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, origin === undefined ? {} : { headers: { Origin: origin } })
    const timer = setTimeout(() => {
      ws.terminate()
      reject(new Error('handshake pendurado'))
    }, 5000)
    ws.on('open', () => {
      clearTimeout(timer)
      ws.close()
      resolve(true)
    })
    ws.on('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
}

function ipForaDoLoopback(): string | null {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list ?? []) {
      if (!i.internal && i.family === 'IPv4') return i.address
    }
  }
  return null
}

// ── sem env: o comportamento de hoje, byte a byte ──────────────────────────

describe('bind padrão (127.0.0.1, sem env)', () => {
  let srv: Booted
  beforeAll(async () => {
    srv = await boot({})
  }, 60000)
  afterAll(async () => {
    await srv?.stop()
  })

  it('nomes locais respondem 200', async () => {
    for (const host of ['localhost', `localhost:${srv.port}`, `127.0.0.1:${srv.port}`, `[::1]:${srv.port}`]) {
      const r = await get('127.0.0.1', srv.port, '/api/health', host)
      expect(r.status, `Host ${host}`).toBe(200)
      expect(JSON.parse(r.body)).toEqual({ ok: true })
    }
  })

  it('qualquer outro Host leva 403 em qualquer rota', async () => {
    for (const host of ['evil.com', 'notlocalhost', 'localhost.evil.com', 'evil-localhost']) {
      const r = await get('127.0.0.1', srv.port, '/api/health', host)
      expect(r.status, `Host ${host}`).toBe(403)
      expect(JSON.parse(r.body)).toEqual({ error: 'Host não permitido' })
    }
    // o guarda vem antes de tudo, até de rota que não existe
    expect((await get('127.0.0.1', srv.port, '/', 'evil.com')).status).toBe(403)
  })

  it('sem Host continua passando (ferramentas locais)', async () => {
    expect((await getSemHost('127.0.0.1', srv.port, '/api/health')).status).toBe(200)
  })

  it('WS: sem Origin abre, Origin local abre, Origin de fora não', async () => {
    const url = `ws://127.0.0.1:${srv.port}/ws`
    expect(await wsAbre(url)).toBe(true)
    expect(await wsAbre(url, 'http://localhost:5173')).toBe(true)
    expect(await wsAbre(url, 'http://evil.com')).toBe(false)
  }, 15000)
})

// ── GREED_HOST fora do loopback: cabeçalhos viram obrigatórios ─────────────

const ip = ipForaDoLoopback()

describe.skipIf(!ip)('bind na rede (GREED_HOST + GREED_ALLOWED_HOSTS)', () => {
  let srv: Booted
  let projDir: string
  let foraDir: string

  beforeAll(async () => {
    srv = await boot({ GREED_HOST: ip as string, GREED_ALLOWED_HOSTS: 'mac.ts.net' }, (cwd) => {
      // um projeto com um entregável dentro e um segredo fora, pro teste do preview
      projDir = path.join(cwd, 'proj')
      foraDir = cwd
      fs.mkdirSync(projDir, { recursive: true })
      fs.writeFileSync(path.join(projDir, 'entregavel.html'), '<h1>ok</h1>')
      fs.writeFileSync(path.join(foraDir, 'segredo.txt'), 'não era pra ler isto')
      const dataDir = path.join(cwd, 'data')
      fs.mkdirSync(dataDir, { recursive: true })
      fs.writeFileSync(
        path.join(dataDir, 'projects.json'),
        JSON.stringify([{ id: 'p1', name: 'teste', path: projDir, createdAt: Date.now() }]),
      )
      fs.writeFileSync(
        path.join(dataDir, 'sessions.json'),
        JSON.stringify([
          {
            id: 's1',
            projectId: 'p1',
            projectName: 'teste',
            title: 'teste',
            sdkSessionId: null,
            model: null,
            effort: null,
            permissionMode: 'default',
            codebasePath: null,
            profile: null,
            open: false,
            status: 'idle',
            attention: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            lastError: null,
          },
        ]),
      )
    })
  }, 60000)
  afterAll(async () => {
    await srv?.stop()
  })

  it('nome da lista, endereço do bind e loopback respondem 200', async () => {
    for (const host of [
      `mac.ts.net:${srv.port}`,
      'MAC.TS.NET',
      `${ip}:${srv.port}`,
      `localhost:${srv.port}`,
    ]) {
      const r = await get(ip as string, srv.port, '/api/health', host)
      expect(r.status, `Host ${host}`).toBe(200)
    }
  })

  it('Host ausente ou parecido leva 403', async () => {
    expect((await getSemHost(ip as string, srv.port, '/api/health')).status).toBe(403)
    for (const host of ['mac.ts.net.evil.com', 'evil-mac.ts.net', 'evil.com']) {
      expect((await get(ip as string, srv.port, '/api/health', host)).status, `Host ${host}`).toBe(403)
    }
  })

  it('WS: Origin da lista abre; ausente, "null" e de fora não', async () => {
    const url = `ws://${ip}:${srv.port}/ws`
    expect(await wsAbre(url, `http://mac.ts.net:${srv.port}`)).toBe(true)
    expect(await wsAbre(url)).toBe(false)
    expect(await wsAbre(url, 'null')).toBe(false)
    expect(await wsAbre(url, 'http://evil.com')).toBe(false)
  }, 15000)

  it('preview serve o arquivo do projeto e segura o ".." sozinho', async () => {
    const host = `mac.ts.net:${srv.port}`
    const ok = await get(ip as string, srv.port, '/preview/s1/entregavel.html', host)
    expect(ok.status).toBe(200)
    expect(ok.body).toContain('<h1>ok</h1>')
    // o guarda de Host deixou passar; a defesa da rota é que tem que segurar
    for (const escape of ['/preview/s1/../segredo.txt', '/preview/s1/..%2fsegredo.txt']) {
      const r = await get(ip as string, srv.port, escape, host)
      expect(r.status, escape).toBe(404)
      expect(r.body).not.toContain('não era pra ler isto')
    }
  })
})
