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
const CHIPS = 3

/** Nome curto, cortado no meio: o que separa dois entregáveis costuma ser o fim
 *  do nome (`-v2`, `-final`), então cortar só no fim deixaria os dois iguais. */
function shortName(rel: string, max = 22): string {
  const name = rel.split('/').pop() ?? rel
  if (name.length <= max) return name
  return `${name.slice(0, max - 10)}…${name.slice(-9)}`
}

/** Trilho fino: um chip por entregável deste chat, o mais novo primeiro. */
export function PreviewRail({ files, openKey, hidden, onOpen, onHide }: Props) {
  if (files.length === 0 || hidden) return null
  const shown = files.slice(0, CHIPS)
  const rest = files.slice(CHIPS)
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
