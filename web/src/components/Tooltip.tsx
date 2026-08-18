import { useEffect, useState } from 'react'

interface Tip {
  text: string
  x: number
  y: number
  below: boolean
}

/**
 * Uma única camada de tooltip pro app inteiro: qualquer elemento com data-tip
 * ganha o balão no estilo do HUD. Fica em position:fixed, então não é cortado
 * por overflow de card, painel ou modal.
 */
export function TooltipLayer() {
  const [tip, setTip] = useState<Tip | null>(null)

  useEffect(() => {
    let timer: number | undefined

    const show = (el: HTMLElement) => {
      const text = el.dataset.tip
      if (!text) return
      const r = el.getBoundingClientRect()
      const below = r.top < 60 // perto do topo da tela, o balão cai pra baixo
      setTip({
        text,
        x: Math.round(r.left + r.width / 2),
        y: Math.round(below ? r.bottom + 6 : r.top - 6),
        below,
      })
    }

    const onOver = (e: MouseEvent) => {
      const el = (e.target as HTMLElement | null)?.closest?.('[data-tip]') as HTMLElement | null
      window.clearTimeout(timer)
      if (!el) {
        setTip(null)
        return
      }
      timer = window.setTimeout(() => show(el), 260)
    }

    const hide = () => {
      window.clearTimeout(timer)
      setTip(null)
    }

    document.addEventListener('mouseover', onOver)
    document.addEventListener('mousedown', hide)
    window.addEventListener('scroll', hide, true)
    window.addEventListener('blur', hide)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('mouseover', onOver)
      document.removeEventListener('mousedown', hide)
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('blur', hide)
    }
  }, [])

  if (!tip) return null
  return (
    <div
      className={`tip ${tip.below ? 'below' : ''}`}
      style={{ left: tip.x, top: tip.y }}
      role="tooltip"
    >
      {tip.text}
    </div>
  )
}
