import { useEffect, useRef, useState } from 'react'

/**
 * Campo de renomear no lugar do texto: Enter salva, Esc cancela, sair do campo
 * salva também. Usado no título do card, no histórico e na lista de projetos.
 */

interface Props {
  value: string
  onCommit: (next: string) => void
  onCancel: () => void
  className?: string
}

export function InlineEdit({ value, onCommit, onCancel, className }: Props) {
  const [text, setText] = useState(value)
  const ref = useRef<HTMLInputElement | null>(null)

  useEffect(() => ref.current?.select(), [])

  const commit = () => {
    const clean = text.trim()
    if (clean && clean !== value) onCommit(clean)
    else onCancel()
  }

  return (
    <input
      ref={ref}
      className={`inline-edit${className ? ` ${className}` : ''}`}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') commit()
        if (e.key === 'Escape') onCancel()
      }}
    />
  )
}
