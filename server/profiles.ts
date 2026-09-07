import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Profile } from '../shared/types'

/**
 * Perfis de conta Claude. Um perfil é uma pasta de config do Claude Code
 * (CLAUDE_CONFIG_DIR): ~/.claude é o padrão, e cada ~/.claude-<nome> logado
 * com `claude /login` vira outra conta. A credencial fica no chaveiro/arquivo
 * daquela pasta, então escolher o perfil escolhe qual assinatura paga a sessão.
 */

/** Nome curto de um perfil a partir da pasta dele. */
export function profileName(dir: string): string {
  const base = path.basename(dir)
  if (base === '.claude') return 'padrão'
  return base.startsWith('.claude-') ? base.slice('.claude-'.length) : base
}

/** Pastas ~/.claude* que parecem config do Claude Code (têm settings ou credencial). */
export function listProfiles(): Profile[] {
  const home = os.homedir()
  let names: string[] = []
  try {
    names = fs.readdirSync(home)
  } catch {
    return []
  }
  const out: Profile[] = []
  for (const name of names) {
    if (name !== '.claude' && !name.startsWith('.claude-')) continue
    const dir = path.join(home, name)
    try {
      if (!fs.statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    const isConfig = ['settings.json', '.credentials.json'].some((f) =>
      fs.existsSync(path.join(dir, f)),
    )
    if (isConfig) out.push({ dir, name: profileName(dir) })
  }
  return out.sort((a, b) =>
    a.name === 'padrão' ? -1 : b.name === 'padrão' ? 1 : a.name.localeCompare(b.name),
  )
}

/** Perfil usado quando a sessão não escolheu: o do ambiente do servidor, senão ~/.claude. */
export function defaultProfileDir(): string | null {
  const fromEnv = process.env.CLAUDE_CONFIG_DIR?.trim()
  if (fromEnv) return fromEnv
  return listProfiles()[0]?.dir ?? null
}

/**
 * Env dos processos do SDK: auth pela assinatura (nunca API key).
 *
 * CLAUDE_CONFIG_DIR só entra quando o perfil NÃO é o padrão (~/.claude): com a
 * variável setada o CLI procura a credencial do perfil nomeado e ignora a
 * credencial padrão do chaveiro ("Claude Code-credentials"), o que derruba a
 * sessão com `authentication_failed` / "Not logged in" mesmo com login válido.
 */
export function envForProfile(profileDir: string | null): Record<string, string | undefined> {
  const dir = profileDir ?? defaultProfileDir()
  const isDefault = !dir || path.resolve(dir) === path.join(os.homedir(), '.claude')
  return {
    ...process.env,
    ANTHROPIC_API_KEY: undefined,
    ...(isDefault ? { CLAUDE_CONFIG_DIR: undefined } : { CLAUDE_CONFIG_DIR: dir }),
  }
}
