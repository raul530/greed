import type { PreviewFile } from './usePreview'

interface Props {
  files: PreviewFile[]
  open: boolean
  hidden: boolean
  onToggle: () => void
  onHide: () => void
}

/** Trilho fino, no mesmo lugar e peso do trilho de atividade. Some se não há html. */
export function PreviewRail({ files, open, hidden, onToggle, onHide }: Props) {
  if (files.length === 0 || hidden) return null
  const head = files[0].rel
  return (
    <button
      className={`act-rail prev-rail ${open ? 'open' : ''}`}
      onClick={onToggle}
      data-tip={
        files.length > 1
          ? `Abrir o preview — ${files.length} arquivos html nesta pasta`
          : 'Abrir o preview deste html em tela grande'
      }
    >
      <span className="prev-rail-eye">▣</span>
      <span className="act-rail-head">{head}</span>
      {files.length > 1 && <span className="act-rail-counts">+{files.length - 1}</span>}
      <span className="act-rail-chev">{open ? '▾' : '▸'}</span>
      <span
        className="prev-rail-x"
        role="button"
        tabIndex={0}
        data-tip="Some com esta barra — ela volta quando ele mexer no arquivo de novo"
        onClick={(e) => {
          e.stopPropagation()
          onHide()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            e.stopPropagation()
            onHide()
          }
        }}
      >
        ✕
      </span>
    </button>
  )
}
