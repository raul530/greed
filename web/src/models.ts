export interface Option {
  value: string // '' = padrão
  label: string
}

// IDs explícitos de modelo — a versão fica visível, importa pro consumo.
export const MODELS: Option[] = [
  { value: '', label: 'Padrão' },
  { value: 'claude-opus-5', label: 'Opus 5' },
  { value: 'claude-opus-4-8', label: 'Opus 4.8' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5' },
  { value: 'claude-fable-5', label: 'Fable 5' },
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
]

// Esforço de raciocínio. Padrão do SDK é 'high'. 'max' = mais raciocínio e consumo.
export const EFFORTS: Option[] = [
  { value: '', label: 'Padrão' },
  { value: 'low', label: 'Baixo' },
  { value: 'medium', label: 'Médio' },
  { value: 'high', label: 'Alto' },
  { value: 'xhigh', label: 'Muito alto' },
  { value: 'max', label: 'Máximo' },
]

export function modelLabel(value: string | null | undefined): string {
  const found = MODELS.find((m) => m.value === (value ?? ''))
  return found ? found.label : (value ?? 'Padrão')
}

export function effortLabel(value: string | null | undefined): string {
  const found = EFFORTS.find((e) => e.value === (value ?? ''))
  return found ? found.label : (value ?? 'Padrão')
}

// Política de permissão por chat.
export const PERMISSION_MODES: Option[] = [
  { value: 'default', label: 'Perguntar sempre' },
  { value: 'acceptEdits', label: 'Auto-edições (pergunta o resto)' },
  { value: 'bypassPermissions', label: 'Não perguntar (autônomo)' },
]

/** rótulo curto para o botão do header */
export function permShort(mode: string): string {
  if (mode === 'bypassPermissions') return 'AUTO'
  if (mode === 'acceptEdits') return 'EDITS'
  return 'ASK'
}

