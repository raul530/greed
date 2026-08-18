import { useEffect, useState } from 'react'
import { api, type SlashCmd } from '../../api'

/** Comandos válidos nesta sessão. Só busca quando alguém digita "/" de verdade. */
export function useCommands(sessionId: string, wanted: boolean) {
  const [cmds, setCmds] = useState<SlashCmd[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!wanted || cmds.length > 0 || loading) return
    setLoading(true)
    void api
      .sessionCommands(sessionId)
      .then((r) => setCmds(r.commands))
      .catch(() => {})
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, sessionId])

  return { cmds, loading }
}

/** Extrai o comando que está sendo digitado; null se o texto não é um comando. */
export function typedCommand(draft: string): string | null {
  if (!draft.startsWith('/')) return null
  const first = draft.slice(1).split(/\s/)[0]
  // depois do espaço já são argumentos: o menu sai de cena
  return /\s/.test(draft) ? null : first
}

export function filterCommands(cmds: SlashCmd[], typed: string): SlashCmd[] {
  const q = typed.toLowerCase()
  const hit = cmds.filter((c) => c.name.toLowerCase().includes(q))
  // quem começa com o que foi digitado vem primeiro; os do Greed lideram o empate
  return hit
    .sort((a, b) => {
      const ap = a.name.toLowerCase().startsWith(q) ? 0 : 1
      const bp = b.name.toLowerCase().startsWith(q) ? 0 : 1
      if (ap !== bp) return ap - bp
      if (a.source !== b.source) return a.source === 'greed' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    .slice(0, 40)
}

interface Props {
  cmds: SlashCmd[]
  loading: boolean
  active: number
  onPick: (cmd: SlashCmd) => void
  onHover: (i: number) => void
}

export function SlashMenu({ cmds, loading, active, onPick, onHover }: Props) {
  if (loading && cmds.length === 0) {
    return (
      <div className="slash-menu">
        <div className="slash-empty">lendo os comandos desta pasta…</div>
      </div>
    )
  }
  if (cmds.length === 0) {
    return (
      <div className="slash-menu">
        <div className="slash-empty">nenhum comando com esse nome</div>
      </div>
    )
  }
  return (
    <div className="slash-menu">
      <div className="slash-list">
        {cmds.map((c, i) => (
          <button
            key={c.name}
            className={`slash-row ${i === active ? 'on' : ''}`}
            onMouseEnter={() => onHover(i)}
            onMouseDown={(e) => {
              e.preventDefault() // não tira o foco do textarea
              onPick(c)
            }}
          >
            <span className="slash-name">
              /{c.name}
              {c.source === 'greed' && <span className="slash-tag">greed</span>}
            </span>
            {c.argumentHint && <span className="slash-arg">{c.argumentHint}</span>}
            <span className="slash-desc">{c.description}</span>
          </button>
        ))}
      </div>
      <div className="slash-foot">↑↓ escolhe · tab completa · enter manda · esc fecha</div>
    </div>
  )
}
