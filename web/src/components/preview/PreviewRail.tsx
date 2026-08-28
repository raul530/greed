import { useEffect, useState } from 'react'
import { fileKey, type PreviewFile } from './usePreview'

interface Props {
  files: PreviewFile[]
  /** chave do arquivo aberto no momento, ou null com o painel fechado */
  openKey: string | null
  hidden: boolean
  onOpen: (file: PreviewFile) => void
  onHide: () => void
}

/** Quantos nomes cabem na barra antes de virar "+N". */
const CHIPS = 4
/** No modo "tudo" a barra pode crescer, mas não virar uma lista sem fim. */
const CHIPS_ALL = 12

/** Nome curto, cortado no meio: o que separa dois entregáveis costuma ser o fim
 *  do nome (`-v2`, `-final`), então cortar só no fim deixaria os dois iguais. */
function shortName(rel: string, max = 22): string {
  const name = rel.split('/').pop() ?? rel
  if (name.length <= max) return name
  return `${name.slice(0, max - 10)}…${name.slice(-9)}`
}

/**
 * Trilho fino: por padrão só o que saiu do último turno — pediu o v2, aparece o
 * v2. O botão da direita abre a lista inteira do chat.
 */
export function PreviewRail({ files, openKey, hidden, onOpen, onHide }: Props) {
  const [all, setAll] = useState(false)
  const fromTurn = files.filter((f) => f.last)
  // turno novo com entregável novo: volta pro modo "só o que ele acabou de fazer"
  const turnKey = fromTurn.map(fileKey).join('|')
  useEffect(() => setAll(false), [turnKey])

  if (files.length === 0 || hidden) return null
  // chat antigo sem leva marcada: mostra tudo, senão a barra ficaria vazia
  const list = all || fromTurn.length === 0 ? files : fromTurn
  const cap = all ? CHIPS_ALL : CHIPS
  const shown = list.slice(0, cap)
  const rest = list.slice(cap)
  const older = files.length - fromTurn.length

  return (
    <div className={`act-rail prev-rail ${openKey ? 'open' : ''}`}>
      <span className="prev-rail-eye">▣</span>
      <span className="prev-rail-files">
        {shown.map((f) => (
          <button
            key={fileKey(f)}
            className={`prev-chip ${openKey === fileKey(f) ? 'on' : ''}`}
            onClick={() => onOpen(f)}
            data-tip={`Abrir ${f.rel} em tela grande`}
          >
            {shortName(f.rel)}
          </button>
        ))}
        {rest.length > 0 && (
          <button
            className="prev-chip more"
            onClick={() => onOpen(rest[0])}
            data-tip={`Mais ${rest.length}: ${rest.map((f) => f.rel).join(', ')}`}
          >
            +{rest.length}
          </button>
        )}
      </span>
      {older > 0 && (
        <button
          className={`prev-chip all ${all ? 'on' : ''}`}
          onClick={() => setAll((v) => !v)}
          data-tip={
            all
              ? 'Voltar a mostrar só o que saiu do último turno'
              : `Mostrar os ${files.length} arquivos que este chat já gerou`
          }
        >
          {all ? 'último turno' : `tudo ${files.length}`}
        </button>
      )}
      <button
        className="prev-rail-x"
        data-tip="Some com esta barra — ela volta quando ele mexer no arquivo de novo"
        onClick={onHide}
      >
        ✕
      </button>
    </div>
  )
}
