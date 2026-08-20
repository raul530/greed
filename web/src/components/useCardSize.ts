import { useState } from 'react'

/**
 * Tamanho que o usuário arrastou num card. O arraste é o resize nativo do
 * navegador (CSS `resize`), que escreve width/height inline; ao soltar, a
 * largura vira número de colunas do grid e a inline é descartada. Assim o card
 * continua alinhado às faixas e os outros se reorganizam sozinhos, que é o que
 * o grid já faz. A altura fica livre, em px.
 */

const KEY = 'greed:cardSize'

interface Size {
  cols: number
  h: string
}

function loadAll(): Record<string, Size> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, Size>
  } catch {
    return {}
  }
}

function saveAll(all: Record<string, Size>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(all))
  } catch {
    // localStorage indisponível — o tamanho vale só nesta aba
  }
}

/** Quantas colunas a largura arrastada cobre, dentro do que o grid tem. */
function colsFor(el: HTMLElement, grid: HTMLElement): number {
  const cs = getComputedStyle(grid)
  const tracks = cs.gridTemplateColumns.split(' ').filter(Boolean)
  const track = parseFloat(tracks[0])
  const gap = parseFloat(cs.columnGap) || 0
  if (!Number.isFinite(track) || track <= 0) return 1
  const wanted = Math.round((el.getBoundingClientRect().width + gap) / (track + gap))
  return Math.max(1, Math.min(tracks.length, wanted))
}

export function useCardSize(sessionId: string) {
  const [size, setSize] = useState<Size | null>(() => loadAll()[sessionId] ?? null)

  return {
    style: size ? { gridColumn: `span ${size.cols}`, height: size.h } : undefined,
    /** chamado ao soltar o mouse; sai fora quando não houve arraste */
    remember(el: HTMLElement): void {
      const dragged = el.style.width || el.style.height
      const grid = el.parentElement
      if (!dragged || !grid) return
      const next = { cols: colsFor(el, grid), h: el.style.height || size?.h || '' }
      el.style.width = ''
      if (size && next.cols === size.cols && next.h === size.h) return
      setSize(next)
      const all = loadAll()
      all[sessionId] = next
      saveAll(all)
    },
  }
}
