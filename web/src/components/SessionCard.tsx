import {
  ArrowUp,
  ChevronDown,
  FolderGit2,
  Lock,
  Maximize2,
  Minimize2,
  Paperclip,
  PencilLine,
  Square,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ActivityItem,
  MsgAttachment,
  PermissionRequest,
  Profile,
  SessionMeta,
  TranscriptEntry,
} from '../../../shared/types'
import { api } from '../api'
import { filesFromClipboard } from '../attachments'
import { EFFORTS, MODELS, permShort } from '../models'
import { ActivityRail } from './activity/ActivityRail'
import { ActivityTree } from './activity/ActivityTree'
import { useActivity } from './activity/useActivity'
import {
  filterCommands,
  SlashMenu,
  typedCommand,
  useCommands,
} from './commands/SlashMenu'
import { InlineEdit } from './InlineEdit'
import { PermissionDock } from './PermissionDock'
import { PreviewPane } from './preview/PreviewPane'
import { PreviewRail } from './preview/PreviewRail'
import { fileKey, usePreview } from './preview/usePreview'
import { Transcript } from './Transcript'
import { UsageChip } from './UsageChip'
import { AttachChips, useAttachments } from './useAttachments'
import { useCardSize } from './useCardSize'
import { useDraft } from './useDraft'

interface Props {
  session: SessionMeta
  entries: TranscriptEntry[]
  permissions: PermissionRequest[]
  activity: ActivityItem[]
  index: number
  expanded: boolean
  connected: boolean
  /** retorna true se a mensagem foi enviada (para o input só limpar no sucesso) */
  onSend: (text: string, attachments: MsgAttachment[]) => boolean
  /** /btw — pergunta de canto, vai pro console lateral e não entra no turno */
  onBtw: (text: string) => void
  onInterrupt: () => void
  onClose: () => void
  onToggleExpand: () => void
  onSeen: () => void
  onPermission: (requestId: string, behavior: 'allow' | 'deny') => void
  onSetModel: (model: string | null) => void
  onSetEffort: (effort: string | null) => void
  onSetPermissionMode: (mode: string) => void
  onRename: (title: string) => void
  profiles: Profile[]
  defaultProfile: string | null
  onSetProfile: (profile: string | null) => void
  registerInput: (el: HTMLTextAreaElement | null) => void
}

const STATUS_LABEL: Record<SessionMeta['status'], string> = {
  idle: 'idle',
  working: 'trabalhando',
  waiting: 'esperando você',
}

/** o composer cresce com o texto até aqui; depois rola por dentro */
const COMPOSER_MAX = 180

export function SessionCard(props: Props) {
  const { session, entries, permissions, index, expanded, connected } = props
  const { draft, setDraft, stale, onBlur, clear: clearDraft } = useDraft(session.id)
  const [dragging, setDragging] = useState(false)
  const [treeOpen, setTreeOpen] = useState(false)
  /** chave do arquivo aberto no preview (null = painel fechado) */
  const [prevOpen, setPrevOpen] = useState<string | null>(null)
  const [slashIndex, setSlashIndex] = useState(0)
  const [renaming, setRenaming] = useState(false)
  const [sendFailed, setSendFailed] = useState<'offline' | 'uploading' | null>(null)
  const act = useActivity(props.activity)
  const rootRef = useRef<HTMLElement | null>(null)
  const size = useCardSize(session.id, rootRef)
  const prev = usePreview(session.id, session.status)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const att = useAttachments((file) => api.uploadAttachment(session.id, file))
  const { addFiles, uploading, ready } = att

  // o App troca a função a cada render; a ref evita re-registrar o textarea toda hora
  const registerRef = useRef(props.registerInput)
  registerRef.current = props.registerInput
  const setTextarea = useCallback((el: HTMLTextAreaElement | null) => {
    taRef.current = el
    registerRef.current(el)
  }, [])

  // composer cresce com o rascunho (e encolhe quando ele é enviado)
  useEffect(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX)}px`
  }, [draft])

  // menu de comandos: só busca a lista quando alguém realmente digita "/"
  const typed = typedCommand(draft)
  const cmd = useCommands(session.id, typed !== null)
  const matches = typed === null ? [] : filterCommands(cmd.cmds, typed)
  const menuOpen = typed !== null && (cmd.loading || matches.length > 0 || typed.length > 0)
  const active = matches[Math.min(slashIndex, matches.length - 1)]

  const complete = (name: string) => {
    setDraft(`/${name} `)
    setSlashIndex(0)
  }

  const submit = () => {
    const text = draft.trim()
    if (!text && ready.length === 0) return
    if (uploading) {
      setSendFailed('uploading')
      return
    }
    if (!connected) {
      setSendFailed('offline')
      return
    }

    // comandos que o Greed resolve sozinho — o resto desce pro Claude Code
    const [head, ...rest] = text.split(/\s+/)
    const arg = text.slice(head.length).trim()
    if (head === '/btw') {
      props.onBtw(arg)
      clearDraft()
      return
    }
    if (head === '/preview') {
      // sem argumento o /preview abre o entregável mais recente do chat
      if (prev.files[0]) setPrevOpen(fileKey(prev.files[0]))
      clearDraft()
      return
    }
    void rest

    if (props.onSend(text, att.payload())) {
      clearDraft()
      att.clear()
      setSendFailed(null)
    } else {
      setSendFailed('offline')
    }
  }

  useEffect(() => {
    if (connected && sendFailed === 'offline') setSendFailed(null)
    if (!uploading && sendFailed === 'uploading') setSendFailed(null)
  }, [connected, uploading, sendFailed])

  const seen = () => {
    if (session.attention) props.onSeen()
  }

  // se a atenção acender enquanto o usuário já está com o card focado, apaga sozinha
  useEffect(() => {
    if (!session.attention) return
    const active = document.activeElement
    if (active && rootRef.current?.contains(active)) props.onSeen()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.attention])

  const cls = [
    'card',
    session.status,
    session.attention ? `attn-${session.attention}` : '',
    expanded ? 'expanded' : '',
    dragging ? 'dragging' : '',
    stale ? 'draft' : '',
  ]
    .filter(Boolean)
    .join(' ')

  const busy = session.status !== 'idle' || permissions.length > 0
  const codebase = session.codebasePath?.split('/').filter(Boolean).pop()

  return (
    <section
      ref={rootRef}
      className={cls}
      style={expanded ? undefined : size.style}
      onMouseDown={seen}
      onPointerUp={(e) => !expanded && size.remember(e.currentTarget)}
      onFocusCapture={seen}
      data-session={session.id}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          setDragging(true)
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false)
      }}
      onDrop={(e) => {
        if (e.dataTransfer.files.length > 0) {
          e.preventDefault()
          setDragging(false)
          void addFiles([...e.dataTransfer.files])
        }
      }}
    >
      <header className="card-head" onDoubleClick={props.onToggleExpand}>
        <div className="card-head-row">
          <div className="card-ident">
            <span className="card-project-name" title={session.projectName}>
              {session.projectName}
            </span>
            {index < 9 && (
              <kbd className="card-kbd" data-tip={`⌘${index + 1} pula pra este card`}>
                {index + 1}
              </kbd>
            )}
            {codebase && (
              <span className="card-tag" data-tip={`Código em ${session.codebasePath}`}>
                <FolderGit2 size={11} />
                <span>{codebase}</span>
              </span>
            )}
            {permissions.length > 0 && (
              <span className="perm-badge" data-tip="Há pedido(s) de permissão esperando você">
                <Lock size={11} />
                decidir
                {permissions.length > 1 ? ` ×${permissions.length}` : ''}
              </span>
            )}
            {stale && (
              <span className="draft-badge" data-tip="Mensagem escrita e não enviada — Enter manda">
                <PencilLine size={11} />
                não enviado
              </span>
            )}
          </div>
          <div className="card-window">
            <span className={`card-status ${session.status}`} data-tip={STATUS_LABEL[session.status]}>
              <span className={`status-dot ${session.status}`} />
              <span className="card-status-label">{STATUS_LABEL[session.status]}</span>
            </span>
            {session.status === 'working' && (
              <button className="icon stop" data-tip="Interromper o turno agora" onClick={props.onInterrupt}>
                <Square size={11} fill="currentColor" strokeWidth={0} />
              </button>
            )}
            <button
              className="icon"
              data-tip={expanded ? 'Restaurar o tamanho do card' : 'Expandir o card na tela'}
              onClick={props.onToggleExpand}
            >
              {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            </button>
            <button className="icon close" data-tip="Fechar — o chat vai pro histórico" onClick={props.onClose}>
              <X size={16} />
            </button>
          </div>
        </div>
        {renaming ? (
          <InlineEdit
            className="card-title-edit"
            value={session.title}
            onCommit={(next) => {
              props.onRename(next)
              setRenaming(false)
            }}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <div
            className="card-title"
            title={`${session.title}\n(duplo clique pra renomear)`}
            onDoubleClick={(e) => {
              e.stopPropagation()
              setRenaming(true)
            }}
          >
            {session.title}
          </div>
        )}
      </header>
      <div className="card-body">
        <Transcript
          entries={entries}
          pending={permissions.length > 0}
          working={session.status === 'working'}
        />
        <PermissionDock permissions={permissions} onPermission={props.onPermission} />
        {treeOpen && <ActivityTree a={act} onClose={() => setTreeOpen(false)} />}
      </div>
      <PreviewRail
        files={prev.files}
        openKey={prevOpen}
        hidden={prev.hidden}
        onOpen={(f) => setPrevOpen((cur) => (cur === fileKey(f) ? null : fileKey(f)))}
        onHide={() => {
          prev.hide()
          setPrevOpen(null)
        }}
      />
      <ActivityRail
        a={act}
        working={session.status === 'working'}
        open={treeOpen}
        onToggle={() => setTreeOpen((v) => !v)}
      />
      <footer className="card-input">
        <AttachChips attachments={att.attachments} onRemove={att.remove} />
        {menuOpen && (
          <SlashMenu
            cmds={matches}
            loading={cmd.loading}
            active={Math.min(slashIndex, Math.max(matches.length - 1, 0))}
            onPick={(c) => complete(c.name)}
            onHover={setSlashIndex}
          />
        )}
        {sendFailed && (
          <div className="send-failed">
            {sendFailed === 'uploading'
              ? 'Esperando o anexo terminar de subir.'
              : 'Sem conexão com o servidor. O texto continua aqui; ele reconecta sozinho, aí é só mandar de novo.'}
          </div>
        )}
        <textarea
          ref={setTextarea}
          className="composer-text"
          value={draft}
          rows={1}
          placeholder={
            !connected
              ? 'Reconectando ao servidor…'
              : session.status === 'waiting'
                ? 'Responda o pedido de permissão acima…'
                : 'Mensagem… Enter envia, / abre os comandos'
          }
          onChange={(e) => {
            setDraft(e.target.value)
            setSlashIndex(0)
          }}
          onBlur={onBlur}
          onPaste={(e) => {
            // print/cópia de imagem colada com ctrl+v vira anexo
            const files = filesFromClipboard(e.clipboardData)
            if (files.length > 0) {
              e.preventDefault()
              void addFiles(files)
            }
          }}
          onKeyDown={(e) => {
            if (menuOpen && matches.length > 0) {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setSlashIndex((i) => (i + 1) % matches.length)
                return
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                setSlashIndex((i) => (i - 1 + matches.length) % matches.length)
                return
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                setDraft('')
                return
              }
              // tab sempre completa; enter completa enquanto o nome não estiver fechado
              const incomplete = active && active.name !== typed
              if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && incomplete)) {
                e.preventDefault()
                if (active) complete(active.name)
                return
              }
            }
            // não envia no meio de composição IME (acentos, CJK)
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <div className="composer-bar">
          <button
            className="icon attach-btn"
            data-tip="Anexar arquivo — ou cole (⌘V) e arraste pro card"
            onClick={() => fileRef.current?.click()}
          >
            <Paperclip size={15} />
          </button>
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) void addFiles([...e.target.files])
              e.target.value = ''
            }}
          />
          {props.profiles.length > 1 && (
            <span className="sel">
              <select
                className="model-select profile-select"
                value={session.profile ?? props.defaultProfile ?? ''}
                disabled={busy}
                data-tip={
                  busy
                    ? 'Conta desta sessão — troca só com o chat parado'
                    : 'Conta que paga esta sessão (troca vale no próximo turno)'
                }
                onChange={(e) => props.onSetProfile(e.target.value || null)}
              >
                {props.profiles.map((p) => (
                  <option key={p.dir} value={p.dir} title={p.dir}>
                    @{p.name}
                  </option>
                ))}
              </select>
              <ChevronDown size={11} />
            </span>
          )}
          <span className="sel">
            <select
              className="model-select"
              value={session.model ?? ''}
              data-tip="Modelo desta sessão (vale a partir do próximo turno)"
              onChange={(e) => props.onSetModel(e.target.value || null)}
            >
              {MODELS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.value ? m.label : 'Modelo'}
                </option>
              ))}
            </select>
            <ChevronDown size={11} />
          </span>
          <span className="sel">
            <select
              className="model-select effort-select"
              value={session.effort ?? ''}
              data-tip="Esforço de raciocínio (mais = mais consumo; vale no próximo turno)"
              onChange={(e) => props.onSetEffort(e.target.value || null)}
            >
              {EFFORTS.map((x) => (
                <option key={x.value} value={x.value}>
                  {x.value ? x.label : 'Esforço'}
                </option>
              ))}
            </select>
            <ChevronDown size={11} />
          </span>
          <button
            className={`perm-toggle ${session.permissionMode}`}
            data-tip={
              session.permissionMode === 'bypassPermissions'
                ? 'Autônomo: roda tools sem pedir. Clique para voltar a perguntar.'
                : 'Pede aprovação. Clique para rodar sem perguntar (autônomo).'
            }
            onClick={() =>
              props.onSetPermissionMode(
                session.permissionMode === 'bypassPermissions' ? 'default' : 'bypassPermissions',
              )
            }
          >
            {permShort(session.permissionMode)}
          </button>
          <span className="composer-spacer" />
          <UsageChip usage={session.usage} />
          <button
            className="send"
            onClick={submit}
            disabled={!draft.trim() && ready.length === 0}
            data-tip={
              uploading
                ? 'Esperando o anexo subir…'
                : stale
                  ? 'Isso ainda não foi enviado — clique ou Enter'
                  : 'Enviar (Enter)'
            }
          >
            <ArrowUp size={16} />
          </button>
        </div>
      </footer>
      {/* o preview vira modal grande: o card é pequeno demais pra testar layout */}
      {prevOpen && (
        <PreviewPane
          sessionId={session.id}
          title={`${session.projectName} — ${session.title}`}
          files={prev.files}
          initial={prevOpen}
          nonce={prev.nonce}
          onReload={prev.reload}
          onClose={() => setPrevOpen(null)}
        />
      )}
      <span className="card-grip" aria-hidden="true" />
    </section>
  )
}
