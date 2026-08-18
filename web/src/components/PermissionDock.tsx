import type { PermissionRequest } from '../../../shared/types'

function formatInput(input: unknown): string {
  try {
    const text = typeof input === 'string' ? input : JSON.stringify(input, null, 2)
    return text.length > 1500 ? `${text.slice(0, 1500)}\n…` : text
  } catch {
    return String(input)
  }
}

interface Props {
  permissions: PermissionRequest[]
  onPermission: (requestId: string, behavior: 'allow' | 'deny') => void
}

/**
 * Ancorado acima do input, fora do scroll do transcript: num card pequeno o
 * painel dentro do transcript ficava cortado e os botões só apareciam
 * expandindo o card. Aqui só o corpo rola — cabeçalho e botões nunca somem.
 * Mostra um pedido por vez; o resto fica na fila e aparece ao decidir este.
 */
export function PermissionDock({ permissions, onPermission }: Props) {
  const permission = permissions[0]
  if (!permission) return null
  const queued = permissions.length - 1

  return (
    <div className="perm-dock">
      <div className="perm-panel">
        <div className="perm-head">
          <span className="perm-siren">🔐</span> Pedido de permissão: <b>{permission.toolName}</b>
          {queued > 0 && <span className="perm-queue">+{queued} na fila</span>}
        </div>
        <pre className="perm-body">{formatInput(permission.input)}</pre>
        <div className="perm-actions">
          <button
            className="allow"
            data-tip="Deixa esta chamada rodar agora"
            onClick={() => onPermission(permission.id, 'allow')}
          >
            Permitir
          </button>
          <button
            className="deny"
            data-tip="Recusa — ele segue o turno sem esta chamada"
            onClick={() => onPermission(permission.id, 'deny')}
          >
            Negar
          </button>
        </div>
      </div>
    </div>
  )
}
