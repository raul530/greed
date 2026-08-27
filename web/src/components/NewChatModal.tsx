import { useEffect, useRef, useState } from 'react'
import type { Profile, Project } from '../../../shared/types'
import { api } from '../api'
import { filesFromClipboard } from '../attachments'
import { EFFORTS, MODELS, PERMISSION_MODES } from '../models'
import { FolderPicker } from './FolderPicker'
import { AttachChips, useAttachments } from './useAttachments'

const PERM_KEY = 'greed:permMode'
const PROFILE_KEY = 'greed:profile'
const codebaseKey = (projectId: string) => `greed:codebase:${projectId}`

interface Props {
  projects: Project[]
  profiles: Profile[]
  onClose: () => void
  onManageProjects: () => void
  onImport: () => void
}

export function NewChatModal({ projects, profiles, onClose, onManageProjects, onImport }: Props) {
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [permMode, setPermMode] = useState(() => {
    try {
      return localStorage.getItem(PERM_KEY) ?? 'bypassPermissions'
    } catch {
      return 'bypassPermissions'
    }
  })
  const [prompt, setPrompt] = useState('')
  const [codebase, setCodebase] = useState('')
  const [profile, setProfile] = useState('')
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => taRef.current?.focus(), [])

  useEffect(() => {
    let saved = ''
    try {
      saved = localStorage.getItem(PROFILE_KEY) ?? ''
    } catch {
      // localStorage indisponível — fica no primeiro perfil
    }
    setProfile(profiles.some((p) => p.dir === saved) ? saved : (profiles[0]?.dir ?? ''))
  }, [profiles])

  // resolve na hora: cobre projetos que chegam depois do mount ou id que sumiu
  const effectiveId = projects.some((p) => p.id === projectId) ? projectId : (projects[0]?.id ?? '')

  // anexo é salvo na pasta do projeto escolhido — sessão ainda não existe
  const att = useAttachments((file) => api.uploadProjectAttachment(effectiveId, file))
  const { addFiles } = att

  // ao trocar de projeto, recupera o último codebase usado nele
  useEffect(() => {
    if (!effectiveId) return
    try {
      setCodebase(localStorage.getItem(codebaseKey(effectiveId)) ?? '')
    } catch {
      setCodebase('')
    }
  }, [effectiveId])

  // anexos já foram gravados na pasta do projeto anterior; não valem pro novo
  useEffect(() => {
    att.clear()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveId])

  const canSubmit = Boolean(effectiveId) && !!prompt.trim() && !busy && !att.uploading

  const submit = async () => {
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    try {
      try {
        localStorage.setItem(PERM_KEY, permMode)
        localStorage.setItem(PROFILE_KEY, profile)
        localStorage.setItem(codebaseKey(effectiveId), codebase)
      } catch {
        // localStorage indisponível — só não persiste a preferência
      }
      await api.newSession(
        effectiveId,
        prompt.trim(),
        model || null,
        effort || null,
        permMode,
        codebase || null,
        profiles.length > 1 ? profile || null : null,
        att.payload(),
      )
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className={`modal${dragging ? ' dragging' : ''}`}
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
        <h2>Novo chat</h2>
        {projects.length === 0 ? (
          <div className="modal-empty">
            <p>Nenhum projeto registrado ainda. Um projeto é uma pasta com seu CLAUDE.md e MCPs.</p>
            <button className="primary" onClick={onManageProjects}>
              Registrar projeto
            </button>
          </div>
        ) : (
          <>
            <label>
              Projeto (contexto)
              <select value={effectiveId} onChange={(e) => setProjectId(e.target.value)}>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} — {p.path}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Codebase (opcional)
              <div className="codebase-row">
                <span className="codebase-path" title={codebase || undefined}>
                  {codebase || 'usa a pasta do projeto'}
                </span>
                <button type="button" onClick={() => setPicking(true)}>
                  Procurar…
                </button>
                {codebase && (
                  <button type="button" className="icon" data-tip="Limpar — volta a usar a pasta do projeto" onClick={() => setCodebase('')}>
                    ✕
                  </button>
                )}
              </div>
            </label>
            <div className="field-row">
              <label>
                Modelo
                <select value={model} onChange={(e) => setModel(e.target.value)}>
                  {MODELS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Esforço
                <select value={effort} onChange={(e) => setEffort(e.target.value)}>
                  {EFFORTS.map((x) => (
                    <option key={x.value} value={x.value}>
                      {x.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="field-row">
              <label>
                Permissões
                <select value={permMode} onChange={(e) => setPermMode(e.target.value)}>
                  {PERMISSION_MODES.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
              {profiles.length > 1 && (
                <label>
                  Conta
                  <select value={profile} onChange={(e) => setProfile(e.target.value)}>
                    {profiles.map((p) => (
                      <option key={p.dir} value={p.dir} title={p.dir}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <p className="field-hint">
              O projeto dá o contexto (CLAUDE.md, memória, documentos). O codebase é a pasta/repo onde
              o agente lê, edita e commita — deixe vazio pra trabalhar na própria pasta do projeto.
              "Não perguntar" roda tools (bash, edições, MCP) sem pedir aprovação.
              {profiles.length > 1 && ' A conta escolhe qual assinatura Claude paga esta sessão.'}
            </p>
            <details className="profile-guide">
              <summary>
                {profiles.length > 1
                  ? 'Como adicionar outra conta Claude?'
                  : 'Quer usar mais de uma conta Claude (pessoal e trabalho)?'}
              </summary>
              <p>
                Cada conta é uma pasta <code>~/.claude-&lt;nome&gt;</code> logada uma vez. No
                terminal:
              </p>
              <pre>{'CLAUDE_CONFIG_DIR=$HOME/.claude-trabalho claude\n# dentro dele: /login'}</pre>
              <p>
                Pronto: o greed detecta as pastas <code>~/.claude*</code> sozinho e a conta nova
                aparece aqui no próximo chat. A pasta <code>~/.claude</code> é a conta "padrão".
              </p>
            </details>
            <label>
              Primeiro prompt
              <AttachChips attachments={att.attachments} onRemove={att.remove} />
              <div className="prompt-row">
                <textarea
                  ref={taRef}
                  rows={5}
                  value={prompt}
                  placeholder="O que essa sessão deve fazer? (📎, ctrl+v ou arraste p/ anexar)"
                  onChange={(e) => setPrompt(e.target.value)}
                  onPaste={(e) => {
                    // print/cópia de imagem colada com ctrl+v vira anexo
                    const files = filesFromClipboard(e.clipboardData)
                    if (files.length > 0) {
                      e.preventDefault()
                      void addFiles(files)
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault()
                      void submit()
                    }
                  }}
                />
                <button
                  type="button"
                  className="attach-btn"
                  data-tip="Anexar arquivo — ou cole (⌘V) e arraste pro modal"
                  onClick={() => fileRef.current?.click()}
                >
                  📎
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
              </div>
            </label>
            {error && <div className="modal-error">{error}</div>}
            <div className="modal-actions">
              <button className="link-action" onClick={onImport}>
                Importar thread do Claude
              </button>
              <button onClick={onClose}>Cancelar</button>
              <button className="primary" disabled={!canSubmit} onClick={() => void submit()}>
                {busy ? 'Abrindo…' : att.uploading ? 'Anexando…' : 'Iniciar (⌘⏎)'}
              </button>
            </div>
          </>
        )}
      </div>
      {picking && (
        <FolderPicker
          onClose={() => setPicking(false)}
          onPick={(picked) => {
            setCodebase(picked)
            setPicking(false)
          }}
        />
      )}
    </div>
  )
}
