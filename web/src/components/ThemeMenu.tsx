import { Check, Moon, Sun, SunMoon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

export const DARK_THEMES = ['orange', 'purple', 'green', 'solar-dark'] as const
export const LIGHT_THEMES = ['paper', 'sage', 'lilac', 'solar-light'] as const
export const MODES = ['auto', 'dark', 'light'] as const

export type Mode = (typeof MODES)[number]

/** o tema escuro e o claro preferidos, e quem decide qual dos dois vale agora */
export interface ThemePref {
  mode: Mode
  dark: string
  light: string
}

const THEME_KEY = 'greed:theme'

export function loadTheme(): ThemePref {
  const fallback: ThemePref = { mode: 'auto', dark: 'orange', light: 'paper' }
  try {
    const raw = localStorage.getItem(THEME_KEY)
    if (!raw) return fallback
    // versão antiga guardava só o nome do tema escuro
    if (!raw.startsWith('{')) return { ...fallback, dark: raw }
    return { ...fallback, ...(JSON.parse(raw) as Partial<ThemePref>) }
  } catch {
    return fallback
  }
}

export function saveTheme(theme: ThemePref): void {
  try {
    localStorage.setItem(THEME_KEY, JSON.stringify(theme))
  } catch {
    // localStorage indisponível — tema só não persiste
  }
}

const MODE_META: Record<Mode, { Icon: typeof Sun; label: string; hint: string }> = {
  auto: { Icon: SunMoon, label: 'auto', hint: 'segue o sistema' },
  dark: { Icon: Moon, label: 'escuro', hint: 'fixo' },
  light: { Icon: Sun, label: 'claro', hint: 'fixo' },
}

const THEME_LABEL: Record<string, string> = {
  orange: 'laranja',
  purple: 'roxo',
  green: 'verde',
  paper: 'papel',
  sage: 'sálvia',
  lilac: 'lilás',
  'solar-dark': 'solarized',
  'solar-light': 'solarized',
}

interface Props {
  theme: ThemePref
  /** tema que está pintando a tela agora */
  activeTheme: string
  scheme: 'dark' | 'light'
  onChange: (next: ThemePref) => void
}

/**
 * Um botão no topo mostra modo + swatch em uso; o clique abre o painel com o
 * modo e os dois conjuntos de temas, com nome, em vez da fileira de quadradinhos.
 */
export function ThemeMenu({ theme, activeTheme, scheme, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const Cur = MODE_META[theme.mode].Icon

  const row = (list: readonly string[], light: boolean) => (
    <div className="theme-row">
      {list.map((t) => {
        const chosen = (light ? theme.light : theme.dark) === t
        return (
          <button
            key={t}
            className={['theme-opt', chosen ? 'on' : '', activeTheme === t ? 'live' : '']
              .filter(Boolean)
              .join(' ')}
            onClick={() => onChange(light ? { ...theme, light: t } : { ...theme, dark: t })}
          >
            <span className={`swatch ${t}`} aria-hidden="true" />
            <span className="theme-opt-name">{THEME_LABEL[t] ?? t}</span>
            {chosen && <Check size={12} />}
          </button>
        )
      })}
    </div>
  )

  return (
    <div className="theme-wrap" ref={ref}>
      <button
        className={`theme-btn ${open ? 'on' : ''}`}
        data-tip="Tema e aparência"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Cur size={14} />
        <span className={`swatch ${activeTheme}`} aria-hidden="true" />
        <i>{MODE_META[theme.mode].label}</i>
      </button>
      {open && (
        <div className="theme-pop" role="dialog" aria-label="Tema">
          <div className="theme-sec">modo</div>
          <div className="theme-modes">
            {MODES.map((m) => {
              const { Icon, label, hint } = MODE_META[m]
              return (
                <button
                  key={m}
                  className={`theme-mode-btn ${theme.mode === m ? 'on' : ''}`}
                  onClick={() => onChange({ ...theme, mode: m })}
                >
                  <Icon size={15} />
                  <span>{label}</span>
                  <small>{hint}</small>
                </button>
              )
            })}
          </div>
          <div className="theme-sec">
            escuro {scheme === 'dark' && <em>em uso</em>}
          </div>
          {row(DARK_THEMES, false)}
          <div className="theme-sec">
            claro {scheme === 'light' && <em>em uso</em>}
          </div>
          {row(LIGHT_THEMES, true)}
        </div>
      )}
    </div>
  )
}
