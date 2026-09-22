import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { envForProfile } from './profiles'

const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'greed-security-'))
fs.writeFileSync(
  path.join(bin, 'security'),
  '#!/bin/sh\ncase "$*" in *credentials-*) v="$SCOPED" ;; *) v="$PLAIN" ;; esac\n[ -n "$v" ] || exit 44\necho "$v"\n',
  { mode: 0o755 },
)
const oldPath = process.env.PATH
process.env.PATH = `${bin}:${oldPath}`
afterAll(() => {
  process.env.PATH = oldPath
})

const login = (expiresAt: number, accessToken = 'tok') =>
  JSON.stringify({ claudeAiOauth: { accessToken, expiresAt } })

function configDirFor(dir: string, keychain: { scoped?: string; plain?: string }) {
  process.env.SCOPED = keychain.scoped ?? ''
  process.env.PLAIN = keychain.plain ?? ''
  return envForProfile(dir).CLAUDE_CONFIG_DIR
}

describe.runIf(process.platform === 'darwin')('envForProfile no perfil padrão', () => {
  const home = path.join(os.homedir(), '.claude')

  it('usa a entrada com sufixo quando ela é a mais nova', () => {
    expect(configDirFor(home, { scoped: login(2000), plain: login(0, '') })).toBe(home)
    expect(configDirFor(home, { scoped: login(2000), plain: login(1000) })).toBe(home)
  })

  it('fica na entrada sem sufixo quando ela é a única ou a mais nova', () => {
    expect(configDirFor(home, { plain: login(1000) })).toBeUndefined()
    expect(configDirFor(home, { scoped: login(1000), plain: login(2000) })).toBeUndefined()
    expect(configDirFor(home, {})).toBeUndefined()
  })

  it('perfil nomeado sempre leva a pasta', () => {
    const other = path.join(os.homedir(), '.claude-trabalho')
    expect(configDirFor(other, { plain: login(2000) })).toBe(other)
  })
})
