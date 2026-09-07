import { useEffect, useState, type RefObject } from 'react'

const KEY = 'greed:cardSize'
/** disparado na janela quando o usuário pede pra voltar tudo ao padrão */
const RESET_EVENT = 'greed:reset-layout'

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

const dirtyListeners = new Set<() => void>()
function notifyDirty(): void {
  for (const l of dirtyListeners) l()
}

/** algum card está fora do tamanho padrão? (liga o botão de resetar no topo) */
export function useLayoutDirty(): boolean {
  const [dirty, setDirty] = useState(() => Object.keys(loadAll()).length > 0)
  useEffect(() => {
    const l = () => setDirty(Object.keys(loadAll()).length > 0)
    dirtyListeners.add(l)
    return () => {
      dirtyListeners.delete(l)
    }
  }, [])
  return dirty
}

/** volta todos os cards ao tamanho padrão e esquece os tamanhos guardados */
export function resetLayout(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {}
  window.dispatchEvent(new Event(RESET_EVENT))
  notifyDirty()
}

export function useCardSize(sessionId: string, ref: RefObject<HTMLElement | null>) {
  const [size, setSize] = useState<Size | null>(() => loadAll()[sessionId] ?? null)

  useEffect(() => {
    const onReset = () => {
      setSize(null)
      // o redimensionador nativo escreve width/height inline por fora do React
      const el = ref.current
      if (el) {
        el.style.width = ''
        el.style.height = ''
      }
    }
    window.addEventListener(RESET_EVENT, onReset)
    return () => window.removeEventListener(RESET_EVENT, onReset)
  }, [ref])

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
      notifyDirty()
    },
  }
}
