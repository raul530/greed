import type { ActivityStatus, FleetOutcome } from '../../../../shared/types'

/**
 * Teatro de operações: a frota desenhada como uma base isométrica.
 *
 * Cada família de tool é um prédio, cada raia (tronco ou subagente) é um boneco que anda até
 * o prédio da tool que está usando, e cada chamada concluída volta pro pátio da sessão como um
 * cubo de carga. Nada aqui é dado novo: é a mesma frota do resto da tela, em miniatura.
 *
 * O arquivo não conhece React nem o modelo da frota: recebe `FieldUnit[]` e um contexto 2D.
 */

export interface FieldSpan {
  key: string
  runId: string
  name: string
  detail: string
  status: ActivityStatus
}

export interface FieldLane {
  id: string
  kind: 'main' | 'subagent' | 'task'
  label: string
  detail: string
  live: boolean
  spans: FieldSpan[]
}

export interface FieldUnit {
  id: string
  project: string
  title: string
  live: boolean
  runId: string | null
  outcome: FleetOutcome | null
  lanes: FieldLane[]
  /** false no exercício: o clique não tem chat pra abrir */
  real: boolean
}

export interface FieldHit {
  sessionId: string | null
  title: string
  sub: string
}

/** `roof`: altura do prédio em px na escala cheia; a placa com o nome flutua logo acima */
const STATIONS = [
  { id: 'arquivo', label: 'arquivo', roof: 34 },
  { id: 'forja', label: 'forja', roof: 22 },
  { id: 'terminal', label: 'terminal', roof: 36 },
  { id: 'antena', label: 'antena', roof: 44 },
  { id: 'portal', label: 'portal', roof: 38 },
  { id: 'oficina', label: 'oficina', roof: 31 },
] as const

export type StationId = (typeof STATIONS)[number]['id']

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead'])
const WRITE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
const SHELL_TOOLS = new Set(['Bash', 'BashOutput', 'KillShell', 'KillBash'])
const WEB_TOOLS = new Set(['WebFetch', 'WebSearch'])

/** em que prédio uma tool trabalha */
export function stationOf(tool: string): StationId {
  if (tool.startsWith('mcp__')) return 'portal'
  if (READ_TOOLS.has(tool)) return 'arquivo'
  if (WRITE_TOOLS.has(tool)) return 'forja'
  if (SHELL_TOOLS.has(tool)) return 'terminal'
  if (WEB_TOOLS.has(tool)) return 'antena'
  return 'oficina'
}

/** nome curto pro balão: de `mcp__servidor__fazAlgo` sobra só `fazAlgo` */
export function shortTool(name: string): string {
  const tail = name.startsWith('mcp__') ? (name.split('__').pop() ?? name) : name
  return tail.length > 18 ? `${tail.slice(0, 17)}…` : tail
}

type RGB = string

interface Palette {
  primary: RGB
  glow: RGB
  alert: RGB
  card: RGB
  muted: string
  mono: string
}

function hexToRgb(hex: string): RGB {
  const h = hex.replace('#', '').trim()
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h
  const n = Number.parseInt(full, 16)
  if (full.length !== 6 || Number.isNaN(n)) return '10, 8, 5'
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`
}

/** as cores saem do tema ativo; a cena inteira é monocromática como o resto do app */
export function readPalette(el: Element): Palette {
  const cs = getComputedStyle(el)
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback
  return {
    primary: v('--primary-rgb', '255, 122, 24'),
    glow: v('--glow-rgb', '255, 154, 60'),
    alert: v('--alert-rgb', '255, 47, 77'),
    card: hexToRgb(v('--card', '#0a0805')),
    muted: v('--muted', '#8a5c38'),
    mono: v('--mono', 'ui-monospace, monospace'),
  }
}

interface Pt {
  x: number
  y: number
}

interface Station extends Pt {
  id: StationId
  label: string
  roof: number
  /** 0..1, sobe enquanto tem alguém trabalhando ali */
  heat: number
  busy: number
  calls: number
}

interface Pad extends Pt {
  slot: number
  unit: FieldUnit
  pile: number
  runId: string | null
  /** pátio recém-aberto: a pilha ainda não foi contada */
  fresh: boolean
  live: boolean
  /** sincronizações esperando o desfecho do turno chegar */
  grace: number
}

interface Job {
  key: string
  station: StationId
  name: string
}

interface Agent extends Pt {
  id: string
  unitId: string | null
  kind: 'bot' | 'drone'
  label: string
  detail: string
  tx: number
  ty: number
  speed: number
  jobs: Job[]
  state: 'idle' | 'walk' | 'work'
  workT: number
  face: 1 | -1
  phase: number
  alpha: number
  gone: boolean
  seed: number
  placed: boolean
  wait: number
}

type Fx =
  | { kind: 'cube'; x0: number; y0: number; padId: string; t: number; dur: number; err: boolean }
  | { kind: 'ring'; x: number; y: number; t: number; dur: number; alert: boolean }
  | { kind: 'text'; x: number; y: number; text: string; t: number; dur: number; alert: boolean }
  | { kind: 'launch'; padId: string; n: number; t: number; dur: number }

interface BoxTone {
  top: number
  left: number
  right: number
  line: number
}

const SENTINEL = '__vigia'
/** tempo mínimo num prédio: tool de 0s também merece ser vista */
const MIN_WORK = 0.55
const PILE_VISIBLE = 18

function hash01(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 10007) / 10007
}

function fract(n: number): number {
  return n - Math.floor(n)
}

export class FieldScene {
  /** sem animação: tudo aparece já no lugar (prefers-reduced-motion) */
  instant = false
  palette: Palette = readPalette(document.documentElement)

  private w = 0
  private h = 0
  private tw = 44
  private th = 22
  private k = 1
  private t = 0
  private stations: Station[] = STATIONS.map((s) => ({ ...s, x: 0, y: 0, heat: 0, busy: 0, calls: 0 }))
  private pads = new Map<string, Pad>()
  private slots: (string | null)[] = []
  private agents = new Map<string, Agent>()
  private seen = new Set<string>()
  private status = new Map<string, ActivityStatus>()
  private fx: Fx[] = []
  private primed = false
  private overflow = 0

  /** unidades sem pátio livre: aparecem só no resto da tela */
  get hidden(): number {
    return this.overflow
  }

  /** esquece tudo; a próxima leitura conta como a primeira */
  reset(): void {
    this.pads.clear()
    this.slots = this.slots.map(() => null)
    this.agents.clear()
    this.seen.clear()
    this.status.clear()
    this.fx = []
    this.primed = false
  }

  resize(w: number, h: number): void {
    this.w = w
    this.h = h
    const narrow = w < 640
    this.tw = narrow ? 34 : 44
    this.th = this.tw / 2
    this.k = this.tw / 44

    const rows = narrow ? [0.2, 0.42] : [0.36]
    const perRow = Math.ceil(this.stations.length / rows.length)
    this.stations.forEach((st, i) => {
      const row = Math.floor(i / perRow)
      const col = i % perRow
      const at = this.snap(((col + 0.5) / perRow) * w, rows[row] * h - this.th / 2)
      st.x = at.x
      st.y = at.y + this.th / 2
    })

    const max = Math.max(narrow ? 2 : 1, Math.min(8, Math.floor(w / (narrow ? 170 : 240))))
    const kept = this.slots.slice(0, max)
    for (const id of this.slots.slice(max)) if (id) this.dropPad(id)
    while (kept.length < max) kept.push(null)
    this.slots = kept
    for (const pad of this.pads.values()) Object.assign(pad, this.padSpot(pad.slot))
  }

  /** casa a cena com o estado da frota; chamada a cada mudança do modelo */
  sync(units: FieldUnit[]): void {
    const byId = new Map(units.map((u) => [u.id, u]))
    for (const id of [...this.pads.keys()]) if (!byId.has(id)) this.dropPad(id)

    this.overflow = 0
    for (const u of units) {
      if (this.pads.has(u.id)) continue
      let slot = this.freeSlot()
      if (slot < 0 && u.live) {
        // unidade em campo tem preferência sobre uma já recolhida
        const idle = [...this.pads.values()].find((p) => !p.live)
        if (idle) {
          slot = idle.slot
          this.dropPad(idle.unit.id)
        }
      }
      if (slot < 0) {
        this.overflow += 1
        continue
      }
      this.slots[slot] = u.id
      this.pads.set(u.id, {
        ...this.padSpot(slot),
        slot,
        unit: u,
        pile: 0,
        runId: u.runId,
        fresh: true,
        live: u.live,
        grace: 0,
      })
    }

    // primeira leitura: o que já terminou não vira reprise, entra direto na pilha
    if (!this.primed) {
      for (const u of units)
        for (const lane of u.lanes)
          for (const s of lane.spans) if (s.status !== 'running') this.seen.add(s.key)
    }

    const nextSeen = new Set<string>()
    const lanesAlive = new Set<string>()
    this.status.clear()
    for (const st of this.stations) st.calls = 0

    for (const u of units) {
      for (const lane of u.lanes) {
        for (const s of lane.spans) {
          nextSeen.add(s.key)
          this.status.set(s.key, s.status)
          const st = this.stations.find((x) => x.id === stationOf(s.name))
          if (st) st.calls += 1
        }
      }
      const pad = this.pads.get(u.id)
      if (!pad) continue
      pad.unit = u

      if (pad.fresh || pad.runId !== u.runId) {
        pad.fresh = false
        pad.runId = u.runId
        pad.pile = u.live
          ? u.lanes.reduce(
              (n, lane) =>
                n +
                lane.spans.filter(
                  (s) => s.runId === u.runId && s.status === 'done' && this.seen.has(s.key),
                ).length,
              0,
            )
          : 0
      }

      // fim de turno: o desfecho pode chegar um evento depois do status
      let live = u.live
      if (pad.live && !u.live && u.outcome === null && pad.grace < 4) {
        pad.grace += 1
        live = true
      }
      if (pad.live && !live) this.endRun(pad)
      if (live !== pad.live) pad.grace = 0
      pad.live = live

      this.ensureAgent(u.id, u.id, 'bot', u.project, u.title)
      for (const lane of u.lanes) {
        const trunk = lane.kind === 'main'
        const id = trunk ? u.id : lane.id
        const fresh = lane.spans.filter((s) => !this.seen.has(s.key))
        let agent = this.agents.get(id)
        if (!trunk) {
          if (!agent && (lane.live || fresh.length > 0)) {
            agent = this.ensureAgent(id, u.id, 'drone', lane.label, lane.detail)
            this.fx.push({ kind: 'ring', x: pad.x, y: pad.y, t: 0, dur: 0.7, alert: false })
          }
          if (agent) {
            agent.gone = !lane.live
            agent.label = lane.label
            agent.detail = lane.detail
            lanesAlive.add(id)
          }
        }
        if (!agent) continue
        for (const s of fresh) agent.jobs.push({ key: s.key, station: stationOf(s.name), name: s.name })
      }
    }

    for (const a of this.agents.values()) {
      if (a.id === SENTINEL) continue
      if (!a.unitId || !this.pads.has(a.unitId)) this.agents.delete(a.id)
      else if (a.kind === 'drone' && !lanesAlive.has(a.id)) a.gone = true
    }

    this.seen = nextSeen
    this.primed = true
  }

  step(dt: number): void {
    this.t += dt
    for (const st of this.stations) st.busy = 0

    const anyLive = [...this.pads.values()].some((p) => p.live)
    const sentinel = this.agents.get(SENTINEL)
    if (!anyLive && !sentinel) this.ensureAgent(SENTINEL, null, 'bot', 'vigia', 'ronda da base vazia')
    else if (sentinel) sentinel.gone = anyLive

    for (const a of this.agents.values()) this.stepAgent(a, dt)
    for (const a of [...this.agents.values()]) if (a.gone && a.alpha <= 0) this.agents.delete(a.id)

    const ease = Math.min(1, dt * 6)
    for (const st of this.stations) st.heat += ((st.busy > 0 ? 1 : 0) - st.heat) * ease

    for (const f of this.fx) f.t += this.instant ? f.dur : dt
    this.fx = this.fx.filter((f) => {
      if (f.t < f.dur) return true
      if (f.kind === 'cube') this.land(f)
      return false
    })
  }

  draw(ctx: CanvasRenderingContext2D): void {
    const { w, h } = this
    ctx.clearRect(0, 0, w, h)
    if (w === 0) return
    ctx.lineWidth = 1
    ctx.lineJoin = 'round'
    ctx.textBaseline = 'alphabetic'

    this.drawFloor(ctx)
    for (const pad of this.pads.values()) this.drawPadGround(ctx, pad)
    this.drawTethers(ctx)

    const things: { y: number; draw: () => void }[] = []
    for (const st of this.stations) things.push({ y: st.y, draw: () => this.drawStation(ctx, st) })
    for (const pad of this.pads.values()) things.push({ y: pad.y - 1, draw: () => this.drawPadProps(ctx, pad) })
    for (const a of this.agents.values()) things.push({ y: a.y, draw: () => this.drawAgent(ctx, a) })
    things.sort((a, b) => a.y - b.y)
    for (const thing of things) thing.draw()

    for (const st of this.stations) this.drawStationLabel(ctx, st)
    for (const f of this.fx) this.drawFx(ctx, f)
    for (const a of this.agents.values()) this.drawBubble(ctx, a)

    if (this.pads.size === 0) {
      this.text(ctx, 'base vazia. o vigia segura as pontas.', w / 2, h - 16 * this.k, this.palette.muted, 9, 'center')
    }
  }

  /** o que está debaixo do cursor: um agente, ou o pátio de uma sessão */
  pick(x: number, y: number): FieldHit | null {
    let best: Agent | null = null
    let bestD = 18 * this.k
    for (const a of this.agents.values()) {
      if (a.alpha < 0.5) continue
      const d = Math.hypot(a.x - x, a.y - 13 * this.k - y)
      if (d < bestD) {
        best = a
        bestD = d
      }
    }
    if (best) {
      const pad = best.unitId ? this.pads.get(best.unitId) : null
      const job = best.jobs[0]
      const doing = job ? `${shortTool(job.name)} · ${job.station}` : best.state === 'idle' ? 'em espera' : ''
      if (!pad) return { sessionId: null, title: best.label, sub: best.detail }
      return {
        sessionId: pad.unit.real ? pad.unit.id : null,
        title: best.kind === 'bot' ? `${pad.unit.project} · tronco` : `${pad.unit.project} · ${best.label}`,
        sub: [best.kind === 'bot' ? pad.unit.title : best.detail, doing].filter(Boolean).join(' — '),
      }
    }
    for (const pad of this.pads.values()) {
      if (Math.abs(pad.x - x) / this.tw + Math.abs(pad.y - y) / this.th > 1) continue
      const state = pad.live ? 'em campo' : pad.unit.outcome === 'error' ? 'falhou' : 'recolhido'
      return {
        sessionId: pad.unit.real ? pad.unit.id : null,
        title: `${pad.unit.project} · ${state}`,
        sub: `${pad.unit.title} — ${pad.pile} carga(s) no pátio`,
      }
    }
    return null
  }

  // ── simulação ────────────────────────────────────────

  /** cruzamento do piso mais perto do ponto, sem sair da fileira: a altura manda, o x cede */
  private snap(sx: number, sy: number): Pt {
    const ox = Math.round(this.w / 2)
    const a = (sx - ox) / (this.tw / 2)
    const row = Math.round(sy / (this.th / 2))
    let col = Math.round(a)
    if ((col - row) % 2 !== 0) col += a > col ? 1 : -1
    return { x: ox + (col * this.tw) / 2, y: (row * this.th) / 2 }
  }

  /** pátio livre mais perto do meio: base com pouca gente não fica torta */
  private freeSlot(): number {
    const mid = (this.slots.length - 1) / 2
    let best = -1
    this.slots.forEach((id, i) => {
      if (id === null && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i
    })
    return best
  }

  private padSpot(slot: number): Pt {
    const n = Math.max(1, this.slots.length)
    return this.snap(((slot + 0.5) / n) * this.w, this.h * (this.w < 640 ? 0.78 : 0.74))
  }

  /** ponto de tela a partir de um centro no chão, um deslocamento em tiles e uma altura */
  private iso(c: Pt, dx: number, dy: number, z = 0): Pt {
    return { x: c.x + ((dx - dy) * this.tw) / 2, y: c.y + ((dx + dy) * this.th) / 2 - z }
  }

  private dropPad(unitId: string): void {
    const pad = this.pads.get(unitId)
    if (!pad) return
    this.pads.delete(unitId)
    if (this.slots[pad.slot] === unitId) this.slots[pad.slot] = null
    for (const a of [...this.agents.values()]) if (a.unitId === unitId) this.agents.delete(a.id)
    this.fx = this.fx.filter((f) => !('padId' in f) || f.padId !== unitId)
  }

  private ensureAgent(
    id: string,
    unitId: string | null,
    kind: Agent['kind'],
    label: string,
    detail: string,
  ): Agent {
    let a = this.agents.get(id)
    if (!a) {
      a = {
        id,
        unitId,
        kind,
        label,
        detail,
        x: 0,
        y: 0,
        tx: Number.NaN,
        ty: Number.NaN,
        speed: 160,
        jobs: [],
        state: 'idle',
        workT: 0,
        face: 1,
        phase: 0,
        alpha: this.instant ? 1 : 0,
        gone: false,
        seed: hash01(id),
        placed: false,
        wait: 0,
      }
      this.agents.set(id, a)
    }
    a.label = label
    a.detail = detail
    return a
  }

  private home(a: Agent): Pt {
    const pad = a.unitId ? this.pads.get(a.unitId) : null
    if (!pad) return { x: this.w / 2, y: this.h * 0.56 }
    if (a.kind === 'bot') return this.iso(pad, -0.35, 0.35)
    return {
      x: pad.x + (a.seed - 0.5) * this.tw * 1.7,
      y: pad.y + this.th * (0.55 + fract(a.seed * 7.3) * 0.45),
    }
  }

  private spot(id: StationId, a: Agent): Pt {
    const st = this.stations.find((s) => s.id === id) ?? this.stations[0]
    return {
      x: st.x + (a.seed - 0.5) * this.tw * 1.2,
      y: st.y + this.th * (1.15 + fract(a.seed * 7.3) * 0.5),
    }
  }

  private pileSpot(pad: Pad, i: number): Pt {
    const n = Math.min(i, PILE_VISIBLE - 1)
    const layer = Math.floor(n / 6)
    const col = n % 3
    const row = Math.floor((n % 6) / 3)
    return this.iso(pad, 0.2 + col * 0.34, -0.6 + row * 0.34, layer * 6 * this.k)
  }

  private stepAgent(a: Agent, dt: number): void {
    const home = this.home(a)
    if (!a.placed) {
      a.x = home.x
      a.y = home.y
      a.placed = true
    }

    let target = home
    let job: Job | undefined
    if (a.id === SENTINEL) {
      a.wait -= dt
      if (Number.isNaN(a.tx) || a.wait <= 0) {
        const st = this.stations[Math.floor(Math.random() * this.stations.length)]
        a.wait = 3 + Math.random() * 4
        target = { x: st.x + (Math.random() - 0.5) * this.tw * 2, y: st.y + this.th * (1.2 + Math.random() * 2.4) }
      } else target = { x: a.tx, y: a.ty }
    } else {
      // fila longa: o que ficou pra trás entra direto na conta, sem encenar
      while (a.jobs.length > 3) this.credit(a, a.jobs.shift()!)
      job = a.jobs[0]
      if (job) target = this.spot(job.station, a)
    }

    if (target.x !== a.tx || target.y !== a.ty) {
      a.tx = target.x
      a.ty = target.y
      const d = Math.hypot(a.tx - a.x, a.ty - a.y)
      a.speed = a.id === SENTINEL ? 46 * this.k : Math.max(170 * this.k, d / 0.9)
    }

    const dx = a.tx - a.x
    const dy = a.ty - a.y
    const d = Math.hypot(dx, dy)
    if (d > 0.5) {
      const move = this.instant ? d : Math.min(d, a.speed * dt)
      a.x += (dx / d) * move
      a.y += (dy / d) * move
      a.state = 'walk'
      a.phase += dt
      if (Math.abs(dx) > 0.5) a.face = dx > 0 ? 1 : -1
    } else if (job) {
      a.state = 'work'
      a.workT += dt
      const st = this.stations.find((s) => s.id === job.station)
      if (st) st.busy += 1
      const status = this.status.get(job.key) ?? 'done'
      if ((this.instant || a.workT >= MIN_WORK) && status !== 'running') {
        a.jobs.shift()
        a.workT = 0
        if (a.unitId) {
          this.fx.push({
            kind: 'cube',
            x0: a.x,
            y0: a.y - 16 * this.k,
            padId: a.unitId,
            t: 0,
            dur: 0.55 + Math.hypot(a.x - home.x, a.y - home.y) / 1400,
            err: status === 'error',
          })
        }
      }
    } else a.state = 'idle'

    const fading = a.gone && a.jobs.length === 0 && a.state === 'idle'
    a.alpha = Math.max(0, Math.min(1, a.alpha + (fading ? -1 : 1) * (this.instant ? 1 : dt * 2.5)))
  }

  private credit(a: Agent, job: Job): void {
    const pad = a.unitId ? this.pads.get(a.unitId) : null
    if (pad && (this.status.get(job.key) ?? 'done') === 'done') pad.pile += 1
  }

  private land(f: Extract<Fx, { kind: 'cube' }>): void {
    const pad = this.pads.get(f.padId)
    if (!pad) return
    const at = this.pileSpot(pad, pad.pile)
    if (!f.err) pad.pile += 1
    if (!this.instant) this.fx.push({ kind: 'ring', x: at.x, y: at.y, t: 0, dur: 0.45, alert: f.err })
  }

  private endRun(pad: Pad): void {
    // o que ainda estava na fila ou no ar embarca junto
    for (const a of this.agents.values()) {
      if (a.unitId !== pad.unit.id) continue
      for (const job of a.jobs.splice(0)) this.credit(a, job)
      a.workT = 0
    }
    for (const f of this.fx) if (f.kind === 'cube' && f.padId === pad.unit.id && !f.err) pad.pile += 1
    this.fx = this.fx.filter((f) => !(f.kind === 'cube' && f.padId === pad.unit.id))

    const failed = pad.unit.outcome === 'error'
    const aborted = pad.unit.outcome === 'aborted'
    const label = failed ? 'falhou' : aborted ? 'abortado' : `entregue ×${pad.pile}`
    if (!this.instant) {
      this.fx.push({ kind: 'text', x: pad.x, y: pad.y - 34 * this.k, text: label, t: 0, dur: 2.2, alert: failed })
      if (!failed && !aborted && pad.pile > 0) {
        this.fx.push({ kind: 'launch', padId: pad.unit.id, n: pad.pile, t: 0, dur: 1.5 })
      }
    }
    if (!failed && !aborted) pad.pile = 0
  }

  // ── desenho ──────────────────────────────────────────

  private rgba(rgb: RGB, a: number): string {
    return `rgba(${rgb}, ${Math.max(0, Math.min(1, a)).toFixed(3)})`
  }

  private text(
    ctx: CanvasRenderingContext2D,
    s: string,
    x: number,
    y: number,
    color: string,
    size: number,
    align: CanvasTextAlign,
    weight = 500,
  ): void {
    ctx.font = `${weight} ${Math.max(7.5, size * Math.max(0.9, this.k))}px ${this.palette.mono}`
    ctx.textAlign = align
    ctx.fillStyle = color
    ctx.fillText(s.toUpperCase(), Math.round(x), Math.round(y))
  }

  private fit(ctx: CanvasRenderingContext2D, s: string, size: number, max: number, weight = 500): string {
    ctx.font = `${weight} ${Math.max(7.5, size * Math.max(0.9, this.k))}px ${this.palette.mono}`
    const up = s.toUpperCase()
    if (ctx.measureText(up).width <= max) return s
    let cut = s
    while (cut.length > 1 && ctx.measureText(`${cut.toUpperCase()}…`).width > max) cut = cut.slice(0, -1)
    return `${cut.trimEnd()}…`
  }

  private poly(ctx: CanvasRenderingContext2D, pts: Pt[], fill: string | null, stroke: string | null): void {
    ctx.beginPath()
    pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
    ctx.closePath()
    if (fill) {
      ctx.fillStyle = fill
      ctx.fill()
    }
    if (stroke) {
      ctx.strokeStyle = stroke
      ctx.stroke()
    }
  }

  private line(ctx: CanvasRenderingContext2D, a: Pt, b: Pt, stroke: string): void {
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.strokeStyle = stroke
    ctx.stroke()
  }

  /** caixa isométrica: base w×d tiles centrada em `c`, altura h px, erguida a z0 do chão */
  private box(
    ctx: CanvasRenderingContext2D,
    c: Pt,
    w: number,
    d: number,
    h: number,
    z0: number,
    rgb: RGB,
    tone: BoxTone,
  ): void {
    const z = z0 + h
    const n = this.iso(c, -w / 2, -d / 2, z)
    const e = this.iso(c, w / 2, -d / 2, z)
    const s = this.iso(c, w / 2, d / 2, z)
    const o = this.iso(c, -w / 2, d / 2, z)
    const down = (p: Pt) => ({ x: p.x, y: p.y + h })
    const solid = `rgb(${this.palette.card})`
    const edge = this.rgba(rgb, tone.line)
    const faces: [Pt[], number][] = [
      [[o, s, down(s), down(o)], tone.left],
      [[s, e, down(e), down(s)], tone.right],
      [[n, e, s, o], tone.top],
    ]
    for (const [pts, alpha] of faces) {
      this.poly(ctx, pts, solid, null)
      this.poly(ctx, pts, this.rgba(rgb, alpha), edge)
    }
  }

  private drawFloor(ctx: CanvasRenderingContext2D): void {
    const { w, h, tw, th } = this
    const ox = Math.round(w / 2)
    const span = Math.ceil(w / tw + h / th) + 2
    ctx.beginPath()
    for (let k = -span; k <= span; k++) {
      // gx = k  e  gy = k: as duas famílias de linhas do piso
      const g0 = -k
      const g1 = (2 * h) / th - k
      ctx.moveTo(ox + ((k - g0) * tw) / 2, 0)
      ctx.lineTo(ox + ((k - g1) * tw) / 2, h)
      ctx.moveTo(ox + ((g0 - k) * tw) / 2, 0)
      ctx.lineTo(ox + ((g1 - k) * tw) / 2, h)
    }
    ctx.strokeStyle = this.rgba(this.palette.primary, 0.085)
    ctx.stroke()

    // bordas somem no painel em vez de cortar seco
    const card = this.palette.card
    const fade = (x0: number, y0: number, x1: number, y1: number, rx: number, ry: number, rw: number, rh: number) => {
      const g = ctx.createLinearGradient(x0, y0, x1, y1)
      g.addColorStop(0, `rgba(${card}, 1)`)
      g.addColorStop(1, `rgba(${card}, 0)`)
      ctx.fillStyle = g
      ctx.fillRect(rx, ry, rw, rh)
    }
    const m = Math.min(70, w * 0.08)
    fade(0, 0, m, 0, 0, 0, m, h)
    fade(w, 0, w - m, 0, w - m, 0, m, h)
    fade(0, 0, 0, 34, 0, 0, w, 34)
    fade(0, h, 0, h - 26, 0, h - 26, w, 26)
  }

  private drawStationLabel(ctx: CanvasRenderingContext2D, st: Station): void {
    const y = st.y - (st.roof + 9) * this.k
    const color = st.heat > 0.3 ? this.rgba(this.palette.glow, 0.95) : this.palette.muted
    const label = st.calls > 0 ? `${st.label} ·${st.calls}` : st.label
    this.text(ctx, label, st.x, y, color, 8.5, 'center', 600)
  }

  private drawStation(ctx: CanvasRenderingContext2D, st: Station): void {
    const { k, t, palette } = this
    const h = st.heat
    const rgb = h > 0.5 ? palette.glow : palette.primary
    const tone: BoxTone = { top: 0.17 + h * 0.2, left: 0.06 + h * 0.08, right: 0.1 + h * 0.12, line: 0.5 + h * 0.4 }
    const hot = this.rgba(palette.glow, 0.25 + h * 0.7)

    switch (st.id) {
      case 'arquivo': {
        for (let i = 0; i < 3; i++) {
          const lift = i === 2 ? h * (2 + Math.sin(t * 9) * 1.5) * k : 0
          this.box(ctx, st, 1.3, 0.9, 8 * k, i * 10 * k + lift, rgb, tone)
          const a = this.iso(st, 0.65, -0.12, i * 10 * k + 4 * k + lift)
          const b = this.iso(st, 0.65, 0.12, i * 10 * k + 4 * k + lift)
          this.line(ctx, a, b, hot)
        }
        if (h > 0.05) {
          // uma ficha sobe da gaveta de cima
          const p = fract(t * 1.3)
          const c = this.iso(st, 0, 0, 34 * k + p * 16 * k)
          this.poly(
            ctx,
            [this.iso(c, -0.2, -0.14), this.iso(c, 0.2, -0.14), this.iso(c, 0.2, 0.14), this.iso(c, -0.2, 0.14)],
            this.rgba(palette.glow, (1 - p) * h * 0.5),
            this.rgba(palette.glow, (1 - p) * h),
          )
        }
        break
      }
      case 'forja': {
        this.box(ctx, st, 1.4, 1.0, 9 * k, 0, rgb, tone)
        this.box(ctx, st, 0.7, 0.4, 6 * k, 9 * k, palette.glow, {
          top: 0.25 + h * 0.65,
          left: 0.12 + h * 0.2,
          right: 0.18 + h * 0.3,
          line: 0.6 + h * 0.4,
        })
        if (h > 0.05) {
          for (let i = 0; i < 7; i++) {
            const p = fract(t * 1.9 + i * 0.143)
            const ang = i * 2.4
            const x = st.x + Math.cos(ang) * p * 17 * k
            const y = st.y - 16 * k - Math.sin(p * Math.PI) * (10 + (i % 3) * 5) * k
            ctx.fillStyle = this.rgba(palette.glow, (1 - p) * h)
            ctx.fillRect(Math.round(x), Math.round(y), 1.5, 1.5)
          }
        }
        break
      }
      case 'terminal': {
        this.box(ctx, st, 0.9, 0.5, 30 * k, 0, rgb, tone)
        const q = (u: number, z: number) => this.iso(st, -0.45 + u * 0.9, 0.25, z)
        this.poly(
          ctx,
          [q(0.14, 26 * k), q(0.86, 26 * k), q(0.86, 9 * k), q(0.14, 9 * k)],
          this.rgba(palette.glow, 0.07 + h * 0.22),
          this.rgba(palette.glow, 0.3 + h * 0.5),
        )
        for (let i = 0; i < 3; i++) {
          const len = h > 0.05 ? 0.25 + fract(Math.floor(t * 7 + i * 3) * 0.37) * 0.4 : [0.5, 0.3, 0.4][i]
          this.line(ctx, q(0.22, (22.5 - i * 4.5) * k), q(0.22 + len, (22.5 - i * 4.5) * k), hot)
        }
        if (Math.floor(t * 2.5) % 2 === 0) {
          const c = q(0.26, 10.5 * k)
          ctx.fillStyle = this.rgba(palette.glow, 0.5 + h * 0.5)
          ctx.fillRect(Math.round(c.x), Math.round(c.y - 2), 2.5, 2)
        }
        break
      }
      case 'antena': {
        this.box(ctx, st, 0.8, 0.8, 6 * k, 0, rgb, tone)
        const base = { x: st.x, y: st.y - 6 * k }
        const tip = { x: st.x, y: st.y - 36 * k }
        this.line(ctx, base, tip, this.rgba(rgb, 0.75 + h * 0.25))
        this.line(ctx, { x: st.x - 5 * k, y: st.y - 6 * k }, { x: st.x, y: st.y - 20 * k }, this.rgba(rgb, 0.4))
        this.line(ctx, { x: st.x + 5 * k, y: st.y - 6 * k }, { x: st.x, y: st.y - 20 * k }, this.rgba(rgb, 0.4))
        ctx.beginPath()
        ctx.ellipse(tip.x, tip.y + 4 * k, 9 * k, 4 * k, -0.35, 0, Math.PI * 2)
        ctx.fillStyle = `rgb(${palette.card})`
        ctx.fill()
        ctx.fillStyle = this.rgba(rgb, 0.14 + h * 0.3)
        ctx.fill()
        ctx.strokeStyle = this.rgba(rgb, 0.7 + h * 0.3)
        ctx.stroke()
        const blink = 0.35 + 0.65 * Math.abs(Math.sin(t * (1.2 + h * 5)))
        ctx.fillStyle = this.rgba(palette.glow, blink)
        ctx.fillRect(Math.round(tip.x) - 1, Math.round(tip.y) - 2, 2.5, 2.5)
        if (h > 0.05) {
          for (let i = 0; i < 3; i++) {
            const p = fract(t * 1.1 + i / 3)
            ctx.beginPath()
            ctx.arc(tip.x, tip.y, (6 + p * 24) * k, -Math.PI * 0.85, -Math.PI * 0.15)
            ctx.strokeStyle = this.rgba(palette.glow, (1 - p) * h * 0.9)
            ctx.stroke()
          }
        }
        break
      }
      case 'portal': {
        const pillar = (dx: number) =>
          this.box(ctx, this.iso(st, dx, 0), 0.26, 0.26, 28 * k, 0, rgb, tone)
        pillar(-0.56)
        const q = (u: number, z: number) => this.iso(st, -0.43 + u * 0.86, 0, z)
        const shimmer = 0.08 + 0.05 * Math.sin(t * 2.2) + h * 0.32
        this.poly(
          ctx,
          [q(0, 27 * k), q(1, 27 * k), q(1, 1 * k), q(0, 1 * k)],
          this.rgba(palette.glow, shimmer),
          null,
        )
        for (let i = 0; i < 4; i++) {
          const p = fract(t * (0.35 + h * 0.9) + i / 4)
          this.line(ctx, q(0, (2 + p * 24) * k), q(1, (2 + p * 24) * k), this.rgba(palette.glow, (0.18 + h * 0.6) * (1 - p)))
        }
        pillar(0.56)
        this.box(ctx, st, 1.4, 0.26, 4 * k, 28 * k, rgb, tone)
        break
      }
      case 'oficina': {
        this.box(ctx, st, 1.2, 1.2, 12 * k, 0, rgb, tone)
        const apex = this.iso(st, 0, 0, 25 * k)
        const e = this.iso(st, 0.6, -0.6, 12 * k)
        const s = this.iso(st, 0.6, 0.6, 12 * k)
        const o = this.iso(st, -0.6, 0.6, 12 * k)
        const edge = this.rgba(rgb, tone.line)
        for (const [pts, a] of [
          [[o, s, apex], tone.left + 0.06],
          [[s, e, apex], tone.right + 0.08],
        ] as [Pt[], number][]) {
          this.poly(ctx, pts, `rgb(${palette.card})`, null)
          this.poly(ctx, pts, this.rgba(rgb, a), edge)
        }
        if (h > 0.05) {
          for (let i = 0; i < 3; i++) {
            const p = fract(t * 0.8 + i / 3)
            ctx.beginPath()
            ctx.arc(apex.x + Math.sin(p * 5 + i) * 3 * k, apex.y - 4 * k - p * 20 * k, (1.5 + p * 3) * k, 0, Math.PI * 2)
            ctx.strokeStyle = this.rgba(palette.glow, (1 - p) * h * 0.8)
            ctx.stroke()
          }
        }
        break
      }
    }
  }

  private drawPadGround(ctx: CanvasRenderingContext2D, pad: Pad): void {
    const { palette, t, k } = this
    const corners = [this.iso(pad, -1, -1), this.iso(pad, 1, -1), this.iso(pad, 1, 1), this.iso(pad, -1, 1)]
    this.poly(ctx, corners, this.rgba(palette.primary, pad.live ? 0.07 : 0.03), null)
    const pulse = pad.live ? 0.55 + 0.4 * Math.abs(Math.sin(t * 2)) : 0.32
    const stroke = this.rgba(pad.live ? palette.glow : palette.primary, pulse)
    corners.forEach((c, i) => {
      const prev = corners[(i + 3) % 4]
      const next = corners[(i + 1) % 4]
      const toward = (p: Pt) => ({ x: c.x + (p.x - c.x) * 0.28, y: c.y + (p.y - c.y) * 0.28 })
      this.line(ctx, c, toward(prev), stroke)
      this.line(ctx, c, toward(next), stroke)
    })

    const width = Math.max(90, this.w / Math.max(1, this.slots.length) - 18)
    const y = pad.y + this.th + 13 * k
    const name = this.fit(ctx, pad.unit.project, 9, width, 700)
    this.text(ctx, name, pad.x, y, pad.live ? this.rgba(palette.glow, 1) : palette.muted, 9, 'center', 700)
    const title = this.fit(ctx, pad.unit.title, 8, width)
    this.text(ctx, title, pad.x, y + 11 * k, palette.muted, 8, 'center')
  }

  private drawPadProps(ctx: CanvasRenderingContext2D, pad: Pad): void {
    const { palette, k, t } = this
    const failed = !pad.live && pad.unit.outcome === 'error'
    const flagRgb = failed ? palette.alert : pad.live ? palette.glow : palette.primary

    const foot = this.iso(pad, -0.72, -0.72)
    const top = { x: foot.x, y: foot.y - 28 * k }
    this.line(ctx, foot, top, this.rgba(palette.primary, 0.7))
    const wave = pad.live ? Math.sin(t * 5) * 1.5 * k : 0
    this.poly(
      ctx,
      [top, { x: top.x + 11 * k, y: top.y + 3.5 * k + wave }, { x: top.x, y: top.y + 7 * k }],
      this.rgba(flagRgb, pad.live || failed ? 0.75 : 0.28),
      this.rgba(flagRgb, 0.9),
    )

    const shown = Math.min(pad.pile, PILE_VISIBLE)
    const dim = pad.live ? 1 : 0.55
    for (let i = 0; i < shown; i++) this.cube(ctx, this.pileSpot(pad, i), dim, failed ? palette.alert : palette.glow)
    if (pad.pile > 0) {
      const at = this.iso(pad, 1.05, -0.2)
      this.text(ctx, `×${pad.pile}`, at.x + 4 * k, at.y, this.rgba(palette.glow, 0.9 * dim), 8.5, 'left', 700)
    }
  }

  private cube(ctx: CanvasRenderingContext2D, at: Pt, alpha: number, rgb: RGB): void {
    this.box(ctx, at, 0.28, 0.28, 5.5 * this.k, 0, rgb, {
      top: 0.55 * alpha,
      left: 0.2 * alpha,
      right: 0.34 * alpha,
      line: 0.85 * alpha,
    })
  }

  private drawTethers(ctx: CanvasRenderingContext2D): void {
    ctx.save()
    ctx.setLineDash([2, 5])
    ctx.lineDashOffset = -this.t * 14
    for (const a of this.agents.values()) {
      const pad = a.unitId ? this.pads.get(a.unitId) : null
      if (!pad || Math.hypot(a.x - pad.x, a.y - pad.y) < this.tw * 1.4) continue
      this.line(ctx, pad, a, this.rgba(this.palette.primary, 0.2 * a.alpha))
    }
    ctx.restore()
  }

  private drawAgent(ctx: CanvasRenderingContext2D, a: Agent): void {
    if (a.alpha <= 0) return
    const { k, t, palette } = this
    const pad = a.unitId ? this.pads.get(a.unitId) : null
    const asleep = a.kind === 'bot' && pad && !pad.live && a.state === 'idle'
    const rgb = palette.glow
    const tone: BoxTone = asleep
      ? { top: 0.3, left: 0.12, right: 0.2, line: 0.6 }
      : { top: 0.8, left: 0.3, right: 0.5, line: 1 }

    ctx.save()
    ctx.globalAlpha = a.alpha
    // o boneco é o protagonista: desenhado um pouco maior que a escala do cenário
    const grow = a.kind === 'bot' ? 1.25 : 1.1
    ctx.translate(a.x, a.y)
    ctx.scale(grow, grow)
    ctx.translate(-a.x, -a.y)

    if (a.kind === 'drone') {
      const z = (13 + Math.sin(t * 3 + a.seed * 9) * 2) * k
      ctx.beginPath()
      ctx.ellipse(a.x, a.y, 5 * k, 2.5 * k, 0, 0, Math.PI * 2)
      ctx.fillStyle = this.rgba(palette.primary, 0.18)
      ctx.fill()
      const c = { x: a.x, y: a.y - z }
      this.box(ctx, c, 0.26, 0.26, 5 * k, 0, rgb, tone)
      // rotor: uma elipse que pisca dá a ilusão de giro
      ctx.beginPath()
      ctx.ellipse(c.x, c.y - 8 * k, 9 * k * (0.55 + 0.45 * Math.abs(Math.sin(t * 22 + a.seed))), 2.4 * k, 0, 0, Math.PI * 2)
      ctx.strokeStyle = this.rgba(rgb, 0.7)
      ctx.stroke()
      this.line(ctx, { x: c.x, y: c.y - 5 * k }, { x: c.x, y: c.y - 8 * k }, this.rgba(rgb, 0.9))
      if (a.state === 'work') {
        this.line(ctx, c, { x: c.x, y: a.y - 1 }, this.rgba(rgb, 0.25 + 0.25 * Math.sin(t * 16)))
      }
      ctx.restore()
      return
    }

    const stride = a.state === 'walk' ? Math.sin(a.phase * 13) : 0
    const bob =
      a.state === 'walk'
        ? Math.abs(stride) * 1.8 * k
        : a.state === 'work'
          ? Math.sin(t * 15) * 0.9 * k
          : asleep
            ? 0
            : Math.sin(t * 2 + a.seed * 6) * 0.5 * k

    ctx.beginPath()
    ctx.ellipse(a.x, a.y, 7.5 * k, 3.6 * k, 0, 0, Math.PI * 2)
    ctx.fillStyle = this.rgba(palette.primary, 0.2)
    ctx.fill()

    const leg = this.rgba(rgb, tone.line)
    const lift = (s: number) => Math.max(0, s) * 2.2 * k
    this.line(ctx, { x: a.x - 2.6 * k, y: a.y - lift(stride) }, { x: a.x - 2.6 * k, y: a.y - 5 * k }, leg)
    this.line(ctx, { x: a.x + 2.6 * k, y: a.y - lift(-stride) }, { x: a.x + 2.6 * k, y: a.y - 5 * k }, leg)

    const body = { x: a.x, y: a.y - 4.5 * k - bob }
    this.box(ctx, body, 0.36, 0.36, 8 * k, 0, rgb, tone)
    const head = { x: a.x, y: asleep ? body.y - 7.5 * k : body.y - 9.5 * k }
    this.box(ctx, head, 0.3, 0.3, 6 * k, 0, rgb, tone)

    // visor na face pra onde ele anda
    const eyeZ = 3.2 * k
    const visor = a.face > 0
      ? [this.iso(head, 0.15, -0.09, eyeZ), this.iso(head, 0.15, 0.11, eyeZ)]
      : [this.iso(head, -0.11, 0.15, eyeZ), this.iso(head, 0.09, 0.15, eyeZ)]
    if (!asleep) this.line(ctx, visor[0], visor[1], `rgb(${palette.card})`)

    const crown = { x: head.x, y: head.y - 6 * k }
    const tip = { x: head.x, y: head.y - 11 * k }
    this.line(ctx, crown, tip, leg)
    const lit = asleep ? 0.3 : a.state === 'work' ? 0.4 + 0.6 * Math.abs(Math.sin(t * 12)) : 0.9
    ctx.fillStyle = this.rgba(rgb, lit)
    ctx.fillRect(Math.round(tip.x) - 1, Math.round(tip.y) - 2, 2.5, 2.5)

    if (a.id === SENTINEL) {
      ctx.globalAlpha = a.alpha * 0.8
      this.text(ctx, 'vigia', a.x, a.y + 11 * k, palette.muted, 7.5, 'center')
    }
    ctx.restore()
  }

  private drawBubble(ctx: CanvasRenderingContext2D, a: Agent): void {
    if (a.alpha < 0.4 || a.id === SENTINEL) return
    const { k, t, palette } = this
    const pad = a.unitId ? this.pads.get(a.unitId) : null
    const job = a.jobs[0]
    const top = a.y - (a.kind === 'bot' ? 41 : 32) * k

    if (a.kind === 'drone' && !job) {
      ctx.globalAlpha = a.alpha * 0.85
      this.text(ctx, this.fit(ctx, a.label, 7.5, 90), a.x, a.y + 11 * k, palette.muted, 7.5, 'center')
      ctx.globalAlpha = 1
      return
    }
    if (!job) {
      if (a.kind !== 'bot' || !pad || a.state !== 'idle') return
      if (!pad.live) {
        // dormindo no pátio
        for (let i = 0; i < 2; i++) {
          const p = fract(t * 0.45 + i * 0.5)
          ctx.globalAlpha = (1 - p) * 0.7
          this.text(ctx, 'z', a.x + (6 + p * 7) * k, top + 12 * k - p * 14 * k, palette.muted, 7.5 + p * 2, 'left', 700)
        }
        ctx.globalAlpha = 1
        return
      }
      this.bubble(ctx, a.x, top, '·'.repeat(1 + (Math.floor(t * 2.5) % 3)).padEnd(3, ' '), false)
      return
    }
    const running = (this.status.get(job.key) ?? 'done') === 'running'
    const label = a.kind === 'drone' ? `${this.fit(ctx, a.label, 8, 70)} › ${shortTool(job.name)}` : shortTool(job.name)
    const cursor = running && a.state === 'work' && Math.floor(t * 3) % 2 === 0 ? '▮' : ' '
    this.bubble(ctx, a.x, top, `${label} ${cursor}`, a.state === 'work')
  }

  private bubble(ctx: CanvasRenderingContext2D, x: number, y: number, label: string, hot: boolean): void {
    const { palette, k } = this
    ctx.font = `600 ${Math.max(7.5, 8 * Math.max(0.9, k))}px ${palette.mono}`
    const up = label.toUpperCase()
    const tw = ctx.measureText(up).width
    const bw = tw + 10
    const bh = 13
    const bx = Math.round(Math.max(4, Math.min(this.w - bw - 4, x - bw / 2))) + 0.5
    const by = Math.round(y - bh) + 0.5
    ctx.fillStyle = `rgba(${palette.card}, 0.92)`
    ctx.fillRect(bx, by, bw, bh)
    ctx.strokeStyle = this.rgba(hot ? palette.glow : palette.primary, hot ? 0.9 : 0.5)
    ctx.strokeRect(bx, by, bw, bh)
    this.line(ctx, { x, y: by + bh }, { x, y: by + bh + 3 }, ctx.strokeStyle as string)
    ctx.textAlign = 'left'
    ctx.fillStyle = this.rgba(palette.glow, hot ? 1 : 0.75)
    ctx.fillText(up, bx + 5, by + bh - 3.5)
  }

  private drawFx(ctx: CanvasRenderingContext2D, f: Fx): void {
    const { palette, k } = this
    const p = Math.min(1, f.t / f.dur)
    switch (f.kind) {
      case 'cube': {
        const pad = this.pads.get(f.padId)
        if (!pad) return
        const to = this.pileSpot(pad, pad.pile)
        const arc = (q: number): Pt => ({
          x: f.x0 + (to.x - f.x0) * q,
          y: f.y0 + (to.y - f.y0) * q - Math.sin(q * Math.PI) * 46 * k,
        })
        const rgb = f.err ? palette.alert : palette.glow
        for (let i = 1; i <= 5; i++) {
          const q = p - i * 0.045
          if (q <= 0) continue
          const at = arc(q)
          ctx.fillStyle = this.rgba(rgb, 0.5 - i * 0.09)
          ctx.fillRect(Math.round(at.x), Math.round(at.y - 3 * k), 1.5, 1.5)
        }
        this.cube(ctx, arc(p), 1, rgb)
        break
      }
      case 'ring': {
        ctx.beginPath()
        ctx.ellipse(f.x, f.y, (3 + p * 20) * k, (1.5 + p * 10) * k, 0, 0, Math.PI * 2)
        ctx.strokeStyle = this.rgba(f.alert ? palette.alert : palette.glow, (1 - p) * 0.9)
        ctx.stroke()
        break
      }
      case 'text': {
        ctx.globalAlpha = p < 0.15 ? p / 0.15 : 1 - Math.max(0, (p - 0.6) / 0.4)
        this.text(ctx, f.text, f.x, f.y - p * 18 * k, this.rgba(f.alert ? palette.alert : palette.glow, 1), 9.5, 'center', 700)
        ctx.globalAlpha = 1
        break
      }
      case 'launch': {
        const pad = this.pads.get(f.padId)
        if (!pad) return
        const rise = p * p * 170 * k
        const alpha = 1 - p ** 1.6
        const mid = this.pileSpot(pad, 1)
        const beam = ctx.createLinearGradient(0, mid.y, 0, mid.y - rise - 40 * k)
        beam.addColorStop(0, this.rgba(palette.glow, 0.5 * alpha))
        beam.addColorStop(1, this.rgba(palette.glow, 0))
        ctx.fillStyle = beam
        ctx.fillRect(mid.x - 9 * k, mid.y - rise - 40 * k, 18 * k, rise + 40 * k)
        for (let i = 0; i < Math.min(f.n, PILE_VISIBLE); i++) {
          const at = this.pileSpot(pad, i)
          this.cube(ctx, { x: at.x, y: at.y - rise * (1 + (i % 6) * 0.05) }, alpha, palette.glow)
        }
        break
      }
    }
  }
}

// ── exercício ────────────────────────────────────────────

const DRILL_TOOLS = [
  'Read', 'Read', 'Grep', 'Glob', 'Edit', 'Edit', 'Write', 'Bash', 'Bash',
  'WebSearch', 'WebFetch', 'mcp__jira__searchIssues', 'mcp__docs__getPage', 'TodoWrite',
]
const DRILL_SUBS = ['Explore', 'Plan', 'general-purpose']

interface DrillSpan extends FieldSpan {
  doneAt: number
}

interface DrillLane extends Omit<FieldLane, 'spans'> {
  spans: DrillSpan[]
  nextAt: number
  until: number
}

interface DrillUnit extends Omit<FieldUnit, 'lanes'> {
  lanes: DrillLane[]
  endsAt: number
  restUntil: number
}

/** frota de mentira pra ver a base viva quando não tem chat trabalhando */
export class FieldDrill {
  private t = 0
  private seq = 0
  private units: DrillUnit[] = [
    this.unit('alfa', 'exercício', 'varrer o repo atrás de código morto', 0),
    this.unit('bravo', 'exercício', 'escrever o PRD do board', 2.5),
  ]

  private unit(id: string, project: string, title: string, delay: number): DrillUnit {
    return {
      id: `drill:${id}`,
      project: `${project} ${id}`,
      title,
      live: false,
      runId: null,
      outcome: null,
      lanes: [],
      real: false,
      endsAt: 0,
      restUntil: delay,
    }
  }

  private rand(min: number, max: number): number {
    return min + Math.random() * (max - min)
  }

  step(dt: number): FieldUnit[] {
    this.t += dt
    const t = this.t
    for (const u of this.units) {
      if (!u.live) {
        if (t < u.restUntil) continue
        u.live = true
        u.outcome = null
        u.runId = `run${++this.seq}`
        u.endsAt = t + this.rand(18, 30)
        u.lanes = [{ id: u.id, kind: 'main', label: 'tronco', detail: u.title, live: true, spans: [], nextAt: t + 0.4, until: Infinity }]
      }
      const ending = t >= u.endsAt
      const subs = u.lanes.filter((l) => l.kind !== 'main' && l.live).length
      if (!ending && subs < 2 && Math.random() < dt * 0.14) {
        const name = DRILL_SUBS[Math.floor(Math.random() * DRILL_SUBS.length)]
        u.lanes.push({
          id: `${u.id}:sub${++this.seq}`,
          kind: 'subagent',
          label: name,
          detail: `${name} em exercício`,
          live: true,
          spans: [],
          nextAt: t + 0.3,
          until: Math.min(u.endsAt, t + this.rand(6, 12)),
        })
      }
      for (const lane of u.lanes) {
        const open = lane.spans.find((s) => s.status === 'running')
        if (open) {
          if (t >= open.doneAt) {
            open.status = Math.random() < 0.06 ? 'error' : 'done'
            lane.nextAt = t + this.rand(0.15, 1.3)
          }
        } else if (ending || t >= lane.until) {
          if (lane.kind !== 'main') lane.live = false
        } else if (t >= lane.nextAt) {
          const name = DRILL_TOOLS[Math.floor(Math.random() * DRILL_TOOLS.length)]
          lane.spans.push({
            key: `${lane.id}:${++this.seq}`,
            runId: u.runId ?? '',
            name,
            detail: '',
            status: 'running',
            doneAt: t + this.rand(0.3, 2.4),
          })
          if (lane.spans.length > 40) lane.spans.shift()
        }
      }
      if (ending && u.lanes.every((l) => !l.spans.some((s) => s.status === 'running'))) {
        u.live = false
        u.outcome = Math.random() < 0.12 ? 'error' : 'ok'
        u.restUntil = t + this.rand(4, 7)
        for (const lane of u.lanes) lane.live = false
      }
    }
    return this.units
  }
}
