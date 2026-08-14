export interface ModelOption {
  value: string // '' = padrão da assinatura
  label: string
}

// Aliases resolvidos pelo Claude Code para o modelo mais recente de cada família.
export const MODELS: ModelOption[] = [
  { value: '', label: 'Padrão' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
]

export function modelLabel(value: string | null | undefined): string {
  const found = MODELS.find((m) => m.value === (value ?? ''))
  return found ? found.label : (value ?? 'Padrão')
}
