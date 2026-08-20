// Consumo da assinatura Claude, lido do mesmo endpoint que o /usage do Claude Code.
// O token OAuth fica no chaveiro (macOS) ou em ~/.claude/.credentials.json e NUNCA
// sai daqui: pro navegador vão só os percentuais já mastigados.
import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { UsageExtra, UsageLimit, UsageSample, UsageSnapshot } from '../shared/types'
import { defaultProfileDir } from './profiles'

const execFileAsync = promisify(execFile)

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const KEYCHAIN_SERVICE = 'Claude Code-credentials'
/** de quanto em quanto tempo a gente bate no endpoint */
export const POLL_MS = 30_000
/** o endpoint limita taxa: nunca duas leituras coladas, nem no botão Atualizar */
const MIN_GAP_MS = 10_000
/** teto do recuo depois de um 429 */
const MAX_BACKOFF_MS = 5 * 60_000
/** o token só é relido do chaveiro depois disso (ou num 401) */
const TOKEN_TTL_MS = 60_000
/** amostra nova no histórico se mudou, ou a cada 5 min mesmo parado */
const SAMPLE_EVERY_MS = 5 * 60_000
const HISTORY_MAX = 2000

const HISTORY_FILE = path.join(process.cwd(), 'data', 'usage-history.json')

/**
 * Todo o estado de leitura (token, última boa, histórico, gap de taxa) vive por
 * conta: cada perfil (CLAUDE_CONFIG_DIR) é uma assinatura com limites próprios.
 * O perfil padrão mantém o arquivo de histórico legado; os outros ganham um
 * arquivo com sufixo derivado da pasta.
 */
interface ProfileUsage {
  dir: string | null
  file: string
  cachedToken: { value: string; readAt: number } | null
  lastCallAt: number
  lastGood: UsageSnapshot | null
  history: UsageSample[]
  historyDirty: boolean
}

const perProfile = new Map<string, ProfileUsage>()

function usageFor(profileDir: string | null): ProfileUsage {
  const def = defaultProfileDir()
  const dir = profileDir ?? def
  const key = dir ?? ''
  let st = perProfile.get(key)
  if (!st) {
    const file =
      dir && dir !== def
        ? path.join(
            process.cwd(),
            'data',
            `usage-history-${crypto.createHash('sha256').update(dir).digest('hex').slice(0, 8)}.json`,
          )
        : HISTORY_FILE
    st = {
      dir,
      file,
      cachedToken: null,
      lastCallAt: 0,
      lastGood: null,
      history: loadHistory(file),
      historyDirty: false,
    }
    perProfile.set(key, st)
  }
  return st
}

interface RawLimit {
  kind?: string
  group?: string
  percent?: number
  severity?: string
  resets_at?: string | null
  is_active?: boolean
  scope?: { model?: { display_name?: string | null } | null; surface?: string | null } | null
}

interface RawUsage {
  five_hour?: { utilization?: number; resets_at?: string | null } | null
  seven_day?: { utilization?: number; resets_at?: string | null } | null
  limits?: RawLimit[]
  extra_usage?: {
    is_enabled?: boolean
    utilization?: number | null
    used_credits?: number | null
    monthly_limit?: number | null
    currency?: string | null
  } | null
  spend?: {
    enabled?: boolean
    percent?: number | null
    used?: { amount_minor?: number; currency?: string } | null
    limit?: { amount_minor?: number } | null
  } | null
}

// ── token ────────────────────────────────────────────────────────────────────

function tokenFromJson(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string } }
    return parsed.claudeAiOauth?.accessToken ?? null
  } catch {
    return null
  }
}

async function readToken(st: ProfileUsage, force = false): Promise<string> {
  if (!force && st.cachedToken && Date.now() - st.cachedToken.readAt < TOKEN_TTL_MS) {
    return st.cachedToken.value
  }
  const fromEnv = process.env.CLAUDE_CODE_OAUTH_TOKEN
  let value: string | null = fromEnv && fromEnv.trim() ? fromEnv.trim() : null

  if (!value && process.platform === 'darwin') {
    const services = [
      ...(st.dir
        ? [
            `${KEYCHAIN_SERVICE}-${crypto.createHash('sha256').update(st.dir).digest('hex').slice(0, 8)}`,
          ]
        : []),
      KEYCHAIN_SERVICE,
    ]
    for (const service of services) {
      try {
        const { stdout } = await execFileAsync('security', [
          'find-generic-password',
          '-s',
          service,
          '-w',
        ])
        value = tokenFromJson(stdout)
        if (value) break
      } catch {
        // sem essa entrada no chaveiro — tenta a próxima, depois o arquivo
      }
    }
  }
  if (!value) {
    try {
      value = tokenFromJson(
        fs.readFileSync(
          path.join(st.dir ?? path.join(os.homedir(), '.claude'), '.credentials.json'),
          'utf8',
        ),
      )
    } catch {
      // sem arquivo de credenciais
    }
  }
  if (!value) {
    throw new Error('Sem credencial do Claude — faça login no Claude Code (claude /login)')
  }
  st.cachedToken = { value, readAt: Date.now() }
  return value
}

// ── normalização ─────────────────────────────────────────────────────────────

function ms(iso?: string | null): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : null
}

function labelFor(raw: RawLimit): string {
  const model = raw.scope?.model?.display_name
  switch (raw.kind) {
    case 'session':
      return 'Limite de 5 horas'
    case 'weekly_all':
      return 'Semanal · todos os modelos'
    case 'weekly_scoped':
      return model ? `Semanal · ${model}` : 'Semanal · por modelo'
    case 'weekly_opus':
      return 'Semanal · Opus'
    default:
      break
  }
  if (model) return `Semanal · ${model}`
  return (raw.kind ?? 'limite').replace(/_/g, ' ')
}

function groupFor(raw: RawLimit): UsageLimit['group'] {
  if (raw.group === 'session' || raw.kind === 'session') return 'session'
  if (raw.group === 'weekly' || raw.kind?.startsWith('weekly')) return 'weekly'
  return 'other'
}

function idFor(raw: RawLimit): string {
  const model = raw.scope?.model?.display_name
  return model ? `${raw.kind ?? 'limit'}:${model}` : (raw.kind ?? 'limit')
}

function normalize(raw: RawUsage): { limits: UsageLimit[]; extra: UsageExtra | null } {
  let limits: UsageLimit[] = (raw.limits ?? []).map((l) => ({
    id: idFor(l),
    label: labelFor(l),
    group: groupFor(l),
    percent: Math.max(0, Math.round(Number(l.percent ?? 0))),
    severity: l.severity ?? 'normal',
    resetsAt: ms(l.resets_at),
    active: l.is_active === true,
  }))

  // contas antigas do endpoint só trazem five_hour/seven_day
  if (limits.length === 0) {
    if (raw.five_hour) {
      limits.push({
        id: 'session',
        label: 'Limite de 5 horas',
        group: 'session',
        percent: Math.round(raw.five_hour.utilization ?? 0),
        severity: 'normal',
        resetsAt: ms(raw.five_hour.resets_at),
        active: true,
      })
    }
    if (raw.seven_day) {
      limits.push({
        id: 'weekly_all',
        label: 'Semanal · todos os modelos',
        group: 'weekly',
        percent: Math.round(raw.seven_day.utilization ?? 0),
        severity: 'normal',
        resetsAt: ms(raw.seven_day.resets_at),
        active: false,
      })
    }
  }

  const order = { session: 0, weekly: 1, other: 2 } as const
  limits = limits.sort((a, b) => order[a.group] - order[b.group] || b.percent - a.percent)

  const ex = raw.extra_usage
  const spend = raw.spend
  const extra: UsageExtra | null =
    ex?.is_enabled || spend?.enabled
      ? {
          enabled: true,
          percent: ex?.utilization ?? spend?.percent ?? null,
          usedMinor: spend?.used?.amount_minor ?? null,
          limitMinor: spend?.limit?.amount_minor ?? ex?.monthly_limit ?? null,
          currency: spend?.used?.currency ?? ex?.currency ?? null,
        }
      : null

  return { limits, extra }
}

// ── histórico ────────────────────────────────────────────────────────────────

function loadHistory(file: string): UsageSample[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as UsageSample[]
    return Array.isArray(parsed) ? parsed.slice(-HISTORY_MAX) : []
  } catch {
    return []
  }
}

function saveHistory(st: ProfileUsage): void {
  if (!st.historyDirty) return
  st.historyDirty = false
  try {
    fs.mkdirSync(path.dirname(st.file), { recursive: true })
    fs.writeFileSync(st.file, JSON.stringify(st.history))
  } catch {
    // histórico é enfeite; se não gravar, tudo bem
  }
}

function pushSample(st: ProfileUsage, limits: UsageLimit[]): void {
  const values: Record<string, number> = {}
  for (const l of limits) values[l.id] = l.percent
  const last = st.history[st.history.length - 1]
  const changed = !last || Object.entries(values).some(([k, v]) => last.values[k] !== v)
  if (!changed && last && Date.now() - last.ts < SAMPLE_EVERY_MS) return
  st.history.push({ ts: Date.now(), values })
  if (st.history.length > HISTORY_MAX) st.history = st.history.slice(-HISTORY_MAX)
  st.historyDirty = true
}

// ── fetch + poll ─────────────────────────────────────────────────────────────

async function callApi(token: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      Accept: 'application/json',
    },
  })
  const body: unknown = await res.json().catch(() => null)
  return { status: res.status, body }
}

/** erro de taxa: quem chama recua em vez de tratar como falha de verdade */
export class RateLimited extends Error {
  constructor() {
    super('Endpoint de uso limitou a taxa; tentando de novo daqui a pouco')
    this.name = 'RateLimited'
  }
}

/** Lê o consumo de uma conta agora (padrão do servidor quando não vem perfil). */
export async function fetchUsage(profileDir: string | null = null): Promise<UsageSnapshot> {
  const st = usageFor(profileDir)
  // duas chamadas coladas (poke + poll, ou dois cliques) só gastariam cota
  if (st.lastGood && Date.now() - st.lastCallAt < MIN_GAP_MS) return st.lastGood
  st.lastCallAt = Date.now()

  let { status, body } = await callApi(await readToken(st))
  if (status === 401 || status === 403) {
    // token pode ter sido renovado pelo Claude Code — relê e tenta de novo
    ;({ status, body } = await callApi(await readToken(st, true)))
  }
  if (status === 429) throw new RateLimited()
  if (status !== 200) {
    const detail =
      body && typeof body === 'object' && 'error' in body
        ? JSON.stringify((body as { error: unknown }).error)
        : `HTTP ${status}`
    throw new Error(`Endpoint de uso respondeu ${status}: ${detail}`)
  }
  const { limits, extra } = normalize((body ?? {}) as RawUsage)
  pushSample(st, limits)
  saveHistory(st) // no-op quando a amostra não mudou nada
  st.lastGood = { fetchedAt: Date.now(), limits, extra, history: st.history }
  return st.lastGood
}

export type UsageListener = (usage: UsageSnapshot | null, error: string | null) => void

/**
 * Fica lendo o consumo enquanto houver alguém olhando (hasClients).
 * `poke` força uma leitura fora do ritmo (ex.: navegador acabou de conectar).
 */
export function startUsagePoller(
  emit: UsageListener,
  hasClients: () => boolean,
): { stop: () => void; poke: () => void } {
  let stopped = false
  let running = false
  let lastError: string | null = null
  let backoffMs = 0
  let nextAllowedAt = 0

  const tick = async () => {
    if (stopped || running || !hasClients() || Date.now() < nextAllowedAt) return
    running = true
    try {
      const usage = await fetchUsage()
      lastError = null
      backoffMs = 0
      emit(usage, null)
    } catch (err) {
      if (err instanceof RateLimited) {
        // recua e segue quieto: a tela já mostra há quanto tempo foi a última leitura
        backoffMs = Math.min(MAX_BACKOFF_MS, Math.max(POLL_MS * 2, backoffMs * 2))
        nextAllowedAt = Date.now() + backoffMs
        // silêncio só faz sentido se já há o que mostrar na tela
        if ((backoffMs >= MAX_BACKOFF_MS || !usageFor(null).lastGood) && lastError !== err.message) {
          lastError = err.message
          emit(null, err.message)
        }
        return
      }
      const message = err instanceof Error ? err.message : String(err)
      if (message !== lastError) {
        lastError = message
        emit(null, message)
      }
    } finally {
      running = false
    }
  }

  void tick()
  const timer = setInterval(() => void tick(), POLL_MS)
  timer.unref?.()
  return {
    stop: () => {
      stopped = true
      clearInterval(timer)
      for (const st of perProfile.values()) saveHistory(st)
    },
    poke: () => void tick(),
  }
}

/** Última leitura boa de uma conta — vale como resposta quando a taxa está travada. */
export function lastKnownUsage(profileDir: string | null = null): UsageSnapshot | null {
  return usageFor(profileDir).lastGood
}
