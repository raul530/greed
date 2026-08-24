import { useState } from 'react'

const KEY = 'greed:cardSize'

interface Size {
  w: string
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
  } catch {}
}

export function useCardSize(sessionId: string) {
  const [size, setSize] = useState<Size | null>(() => loadAll()[sessionId] ?? null)

  return {
    style: size ? { width: size.w, height: size.h } : undefined,
    remember(el: HTMLElement): void {
      const next = { w: el.style.width, h: el.style.height }
      if (!next.w && !next.h) return
      if (size && next.w === size.w && next.h === size.h) return
      setSize(next)
      const all = loadAll()
      all[sessionId] = next
      saveAll(all)
    },
  }
}
