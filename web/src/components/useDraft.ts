import { useEffect, useRef, useState } from 'react'

/** tempo parado com texto escrito até o rascunho começar a chamar atenção */
const IDLE_MS = 9000
const key = (sessionId: string) => `greed:draft:${sessionId}`

function load(sessionId: string): string {
  try {
    return localStorage.getItem(key(sessionId)) ?? ''
  } catch {
    return ''
  }
}

/**
 * Rascunho do composer: sobrevive a reload e avisa quando ficou escrito e
 * parado. O aviso liga quando você para de digitar, ou na hora se sair do
 * campo — o caso clássico é escrever, distrair com outro card e esquecer.
 */
export function useDraft(sessionId: string) {
  const [draft, setDraft] = useState(() => load(sessionId))
  // rascunho que voltou do localStorage já nasce esquecido: é de outra sessão de trabalho
  const [stale, setStale] = useState(() => load(sessionId).trim().length > 0)
  const first = useRef(true)

  // conta o tempo parado; qualquer tecla zera
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    setStale(false)
    if (!draft.trim()) return
    const t = window.setTimeout(() => setStale(true), IDLE_MS)
    return () => window.clearTimeout(t)
  }, [draft])

  // persiste (com folga, pra não escrever a cada tecla)
  useEffect(() => {
    const t = window.setTimeout(() => {
      try {
        if (draft) localStorage.setItem(key(sessionId), draft)
        else localStorage.removeItem(key(sessionId))
      } catch {
        // sem localStorage o rascunho só não sobrevive ao reload
      }
    }, 300)
    return () => window.clearTimeout(t)
  }, [draft, sessionId])

  return {
    draft,
    setDraft,
    /** texto escrito e esquecido — o card acende pedindo o Enter */
    stale: stale && draft.trim().length > 0,
    /** saiu do campo com texto: avisa na hora, sem esperar o timer */
    onBlur: () => draft.trim() && setStale(true),
    clear: () => {
      setDraft('')
      setStale(false)
      try {
        localStorage.removeItem(key(sessionId))
      } catch {
        // ignora
      }
    },
  }
}
