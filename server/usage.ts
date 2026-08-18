// Consumo da assinatura Claude, lido do mesmo endpoint que o /usage do Claude Code.
// O token OAuth fica no chaveiro (macOS) ou em ~/.claude/.credentials.json e NUNCA
// sai daqui: pro navegador vão só os percentuais já mastigados.
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { UsageExtra, UsageLimit, UsageSample, UsageSnapshot } from '../shared/types'

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

let cachedToken: { value: string; readAt: number } | null = null

function tokenFromJson(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string } }
    return parsed.claudeAiOauth?.accessToken ?? null
  } catch {
    return null
  }
}

async function readToken(force = false): Promise<string> {
  if (!force && cachedToken && Date.now() - cachedToken.readAt < TOKEN_TTL_MS) {
    return cachedToken.value
  }
  const fromEnv = process.env.CLAUDE_CODE_OAUTH_TOKEN
  let value: string | null = fromEnv && fromEnv.trim() ? fromEnv.trim() : null

  if (!value && process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('security', [
        'find-generic-password',
        '-s',
        KEYCHAIN_SERVICE,
        '-w',
      ])
      value = tokenFromJson(stdout)
    } catch {
      // sem entrada no chaveiro — cai no arquivo
    }
  }
  if (!value) {
    try {
      value = tokenFromJson(fs.readFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8'))
    } catch {
      // sem arquivo de credenciais
    }
  }
  if (!value) {
    throw new Error('Sem credencial do Claude — faça login no Claude Code (claude /login)')
  }
  cachedToken = { value, readAt: Date.now() }
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

function loadHistory(): UsageSample[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')) as UsageSample[]
    return Array.isArray(parsed) ? parsed.slice(-HISTORY_MAX) : []
  } catch {
    return []
  }
}

let history: UsageSample[] = loadHistory()
let historyDirty = false

function saveHistory(): void {
  if (!historyDirty) return
  historyDirty = false
  try {
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true })
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history))
  } catch {
    // histórico é enfeite; se não gravar, tudo bem
  }
}

function pushSample(limits: UsageLimit[]): void {
  const values: Record<string, number> = {}
  for (const l of limits) values[l.id] = l.percent
  const last = history[history.length - 1]
  const changed = !last || Object.entries(values).some(([k, v]) => last.values[k] !== v)
  if (!changed && last && Date.now() - last.ts < SAMPLE_EVERY_MS) return
  history.push({ ts: Date.now(), values })
  if (history.length > HISTORY_MAX) history = history.slice(-HISTORY_MAX)
  historyDirty = true
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

let lastCallAt = 0
/** última leitura boa — serve pra devolver algo quando a taxa está travada */
let lastGood: UsageSnapshot | null = null

/** Lê o consumo agora. Lança com mensagem legível quando não dá. */
export async function fetchUsage(): Promise<UsageSnapshot> {
  // duas chamadas coladas (poke + poll, ou dois cliques) só gastariam cota
  if (lastGood && Date.now() - lastCallAt < MIN_GAP_MS) return lastGood
  lastCallAt = Date.now()

  let { status, body } = await callApi(await readToken())
  if (status === 401 || status === 403) {
    // token pode ter sido renovado pelo Claude Code — relê e tenta de novo
    ;({ status, body } = await callApi(await readToken(true)))
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
  pushSample(limits)
  saveHistory() // no-op quando a amostra não mudou nada
  lastGood = { fetchedAt: Date.now(), limits, extra, history }
  return lastGood
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
        if ((backoffMs >= MAX_BACKOFF_MS || !lastGood) && lastError !== err.message) {
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
      saveHistory()
    },
    poke: () => void tick(),
  }
}

/** Última leitura boa — vale como resposta quando a taxa está travada. */
export function lastKnownUsage(): UsageSnapshot | null {
  return lastGood
}

/** Último histórico conhecido — usado quando o fetch falha mas já temos amostras. */
export function usageHistory(): UsageSample[] {
  return history
}
