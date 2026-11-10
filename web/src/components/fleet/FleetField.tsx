import { useEffect, useMemo, useRef, useState } from 'react'
import { FieldDrill, FieldScene, readPalette, type FieldHit, type FieldUnit } from './fieldScene'
import type { FleetUnit } from './useFleet'

interface Props {
  units: FleetUnit[]
  onOpen: (sessionId: string) => void
}

function toField(u: FleetUnit): FieldUnit {
  return {
    id: u.session.id,
    project: u.session.projectName,
    title: u.session.title,
    live: u.live,
    runId: u.run?.id ?? null,
    outcome: u.run?.outcome ?? null,
    real: true,
    lanes: u.lanes.map((lane) => ({
      id: lane.id,
      kind: lane.kind,
      label: lane.label,
      detail: lane.detail,
      live: lane.live,
      spans: lane.spans.map((s) => ({
        key: s.key,
        runId: s.runId,
        name: s.name,
        detail: s.detail || s.target || '',
        status: s.status,
      })),
    })),
  }
}

/** a frota como uma base isométrica: mesma informação do resto da tela, só que andando */
export function FleetField({ units, onOpen }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sceneRef = useRef<FieldScene | null>(null)
  const [drill, setDrill] = useState(false)
  const [tip, setTip] = useState<(FieldHit & { x: number; y: number }) | null>(null)
  const [hidden, setHidden] = useState(0)

  const input = useMemo(() => units.map(toField), [units])
  const inputRef = useRef(input)
  inputRef.current = input
  const drillRef = useRef<FieldDrill | null>(null)
  drillRef.current = drill ? (drillRef.current ?? new FieldDrill()) : null

  useEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!wrap || !canvas || !ctx) return

    const scene = new FieldScene()
    sceneRef.current = scene
    const still = window.matchMedia('(prefers-reduced-motion: reduce)')
    scene.instant = still.matches

    const fit = () => {
      const dpr = window.devicePixelRatio || 1
      const { width, height } = wrap.getBoundingClientRect()
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      scene.resize(width, height)
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(wrap)

    let raf = 0
    let timer = 0
    let last = performance.now()
    let synced: FieldUnit[] | null = null
    let drilling = false
    let paletteAt = 0
    const frame = (ts: number) => {
      const dt = Math.min(0.05, Math.max(0, (ts - last) / 1000))
      last = ts
      // o tema troca por atributo no <html>; reler de vez em quando é mais barato que observar
      if (ts - paletteAt > 800) {
        scene.palette = readPalette(canvas)
        scene.instant = still.matches
        paletteAt = ts
        setHidden(scene.hidden)
      }
      const drillRun = drillRef.current
      if (drilling !== !!drillRun) {
        // frota de mentira e frota de verdade não dividem a base
        drilling = !!drillRun
        scene.reset()
        synced = null
      }
      if (drillRun) {
        scene.sync(drillRun.step(dt))
      } else if (synced !== inputRef.current) {
        synced = inputRef.current
        scene.sync(synced)
      }
      scene.step(dt)
      scene.draw(ctx)
      if (scene.instant) timer = window.setTimeout(() => frame(performance.now()), 500)
      else raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(raf)
      window.clearTimeout(timer)
      ro.disconnect()
      sceneRef.current = null
    }
  }, [])

  const hitAt = (e: React.MouseEvent) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const hit = sceneRef.current?.pick(x, y) ?? null
    return hit ? { ...hit, x, y } : null
  }

  return (
    <>
      <header className="fl-head">
        <h2>teatro de operações</h2>
        <div className="fl-field-tools">
          <span className="fl-head-note">
            {drill
              ? 'dados simulados'
              : hidden > 0
                ? `+${hidden} unidade(s) sem pátio`
                : 'cada cubo é uma chamada concluída'}
          </span>
          <button
            className={`fl-win ${drill ? 'active' : ''}`}
            onClick={() => setDrill((on) => !on)}
            data-tip="Solta uma frota de mentira na base, pra ver ela trabalhando"
          >
            exercício
          </button>
        </div>
      </header>
      <div
        ref={wrapRef}
        className="fl-field"
        data-hit={tip ? (tip.sessionId ? 'open' : 'info') : undefined}
        onMouseMove={(e) => setTip(hitAt(e))}
        onMouseLeave={() => setTip(null)}
        onClick={(e) => {
          const hit = hitAt(e)
          if (hit?.sessionId) onOpen(hit.sessionId)
        }}
      >
        <canvas ref={canvasRef} role="img" aria-label="base isométrica com os agentes da frota em atividade" />
        {tip && (
          <div
            className="fl-field-tip"
            style={{ left: tip.x, top: tip.y }}
            data-side={tip.x > (wrapRef.current?.clientWidth ?? 0) * 0.7 ? 'left' : 'right'}
          >
            <b>{tip.title}</b>
            {tip.sub && <span>{tip.sub}</span>}
          </div>
        )}
      </div>
    </>
  )
}
