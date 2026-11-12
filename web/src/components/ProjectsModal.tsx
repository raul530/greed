import { Download, Pencil, Upload, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Project } from '../../../shared/types'
import { api } from '../api'
import { FolderPicker } from './FolderPicker'
import { InlineEdit } from './InlineEdit'

interface Props {
  projects: Project[]
  onClose: () => void
}

/** arquivo de memória escolhido, lido o bastante para mostrar o que vai entrar */
interface PendingImport {
  projectId: string
  file: File
  source: string
  count: number
  exportedAt: string
}

const plural = (n: number): string => `${n} ${n === 1 ? 'memória' : 'memórias'}`

function day(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('pt-BR')
}

/** Lê o arquivo no navegador só para conferir e descrever; quem valida de verdade é o servidor. */
async function inspect(file: File, projectId: string): Promise<PendingImport> {
  let parsed: { kind?: unknown; project?: unknown; exportedAt?: unknown; entries?: unknown }
  try {
    parsed = JSON.parse(await file.text())
  } catch {
    throw new Error('Esse arquivo não é uma memória exportada pelo Greed')
  }
  if (parsed?.kind !== 'greed-memory' || !Array.isArray(parsed.entries)) {
    throw new Error('Esse arquivo não é uma memória exportada pelo Greed')
  }
  return {
    projectId,
    file,
    source: typeof parsed.project === 'string' ? parsed.project : 'sem nome',
    count: parsed.entries.length,
    exportedAt: typeof parsed.exportedAt === 'string' ? day(parsed.exportedAt) : '',
  }
}

export function ProjectsModal({ projects, onClose }: Props) {
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [picking, setPicking] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [totals, setTotals] = useState<Record<string, number>>({})
  const [pending, setPending] = useState<PendingImport | null>(null)
  const [importing, setImporting] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const importTarget = useRef<string | null>(null)

  const fail = (err: unknown) => setError(err instanceof Error ? err.message : String(err))

  const loadTotals = useCallback(() => {
    api
      .memoryTotals()
      .then((r) => setTotals(r.totals))
      .catch(() => {})
  }, [])

  // a lista muda quando um projeto entra ou sai; a contagem acompanha
  useEffect(loadTotals, [loadTotals, projects.length])

  const add = async () => {
    if (!name.trim() || !path.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      await api.addProject(name, path)
      setName('')
      setPath('')
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  const chooseFile = (projectId: string) => {
    importTarget.current = projectId
    fileInput.current?.click()
  }

  const onFile = async (file: File | undefined) => {
    const projectId = importTarget.current
    if (!file || !projectId) return
    setError(null)
    setNotice(null)
    try {
      setPending(await inspect(file, projectId))
    } catch (err) {
      setPending(null)
      fail(err)
    }
  }

  const confirmImport = async () => {
    if (!pending || importing) return
    const target = projects.find((p) => p.id === pending.projectId)
    setImporting(true)
    setError(null)
    try {
      const r = await api.importMemory(pending.projectId, pending.file)
      const where = target?.name ?? 'projeto'
      setNotice(
        r.added === 0
          ? `Nada novo: ${where} já tinha todas as ${plural(r.skipped)} desse arquivo.`
          : `${plural(r.added)} importada${r.added === 1 ? '' : 's'} para ${where}` +
              (r.skipped > 0 ? ` (${r.skipped} já estavam lá).` : '.'),
      )
      setPending(null)
      loadTotals()
    } catch (err) {
      fail(err)
    } finally {
      setImporting(false)
    }
  }

  const pendingTarget = pending ? projects.find((p) => p.id === pending.projectId) : undefined
  const pendingHas = pending ? (totals[pending.projectId] ?? 0) : 0

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <h2>Projetos</h2>
        <p className="modal-hint">
          Cada projeto é uma pasta (ex.: o repositório do seu código). A sessão roda com esse working
          directory e usa o CLAUDE.md e o .mcp.json que estiverem lá. Sendo um repo, é só pedir no chat
          pra commitar, criar branch etc. A memória de um projeto pode ser exportada num arquivo e
          importada no Greed de outra pessoa.
        </p>
        {projects.length > 0 && (
          <ul className="project-list">
            {projects.map((p) => {
              const total = totals[p.id] ?? 0
              return (
                <li key={p.id}>
                  <div className="project-info">
                    {editing === p.id ? (
                      <InlineEdit
                        value={p.name}
                        onCommit={(next) => {
                          setEditing(null)
                          api.renameProject(p.id, next).catch(fail)
                        }}
                        onCancel={() => setEditing(null)}
                      />
                    ) : (
                      <b>{p.name}</b>
                    )}
                    <span className="project-path">{p.path}</span>
                    <span className="project-mem">{total > 0 ? plural(total) : 'sem memória ainda'}</span>
                  </div>
                  {total > 0 ? (
                    <a
                      className="icon"
                      href={api.memoryExportUrl(p.id)}
                      download
                      title={`Exportar a memória (${plural(total)}) num arquivo`}
                    >
                      <Download size={14} />
                    </a>
                  ) : (
                    <button className="icon" disabled title="Esse projeto ainda não tem memória">
                      <Download size={14} />
                    </button>
                  )}
                  <button
                    className="icon"
                    title="Importar memória de um arquivo exportado"
                    onClick={() => chooseFile(p.id)}
                  >
                    <Upload size={14} />
                  </button>
                  <button className="icon" title="Renomear" onClick={() => setEditing(p.id)}>
                    <Pencil size={14} />
                  </button>
                  <button
                    className="icon danger"
                    title="Remover projeto (não apaga a pasta)"
                    onClick={() => api.removeProject(p.id).catch(fail)}
                  >
                    <X size={14} />
                  </button>
                </li>
              )
            })}
          </ul>
        )}
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = '' // escolher o mesmo arquivo de novo tem que disparar
            void onFile(file)
          }}
        />
        {pending && (
          <div className="memory-import">
            <p>
              <b>{plural(pending.count)}</b> do projeto <b>{pending.source}</b>
              {pending.exportedAt && `, exportadas em ${pending.exportedAt}`}. Importar para{' '}
              <b>{pendingTarget?.name ?? 'este projeto'}</b>?
            </p>
            <p className="modal-hint">
              {pendingHas > 0
                ? `Esse projeto já tem ${plural(pendingHas)}: só entra o que ainda não está lá, e nada é apagado. `
                : ''}
              O conteúdo passa a entrar no contexto de todo chat do projeto. Só importe arquivo de quem
              você confia.
            </p>
            <div className="modal-actions">
              <button disabled={importing} onClick={() => setPending(null)}>
                Cancelar
              </button>
              <button className="primary" disabled={importing} onClick={() => void confirmImport()}>
                {importing ? 'Importando…' : 'Importar'}
              </button>
            </div>
          </div>
        )}
        {notice && <div className="modal-notice">{notice}</div>}
        <div className="project-add">
          <input
            placeholder="Nome (ex.: Trabalho)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            placeholder="Pasta (ex.: ~/repos/meu-projeto)"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void add()}
          />
          <button onClick={() => setPicking(true)} title="Navegar pelas pastas">
            Procurar…
          </button>
          <button className="primary" disabled={!name.trim() || !path.trim() || busy} onClick={() => void add()}>
            Adicionar
          </button>
        </div>
        {error && <div className="modal-error">{error}</div>}
        <div className="modal-actions">
          <button onClick={onClose}>Fechar</button>
        </div>
      </div>
      {picking && (
        <FolderPicker
          onClose={() => setPicking(false)}
          onPick={(picked) => {
            setPath(picked)
            if (!name.trim()) setName(picked.split('/').filter(Boolean).pop() ?? '')
            setPicking(false)
          }}
        />
      )}
    </div>
  )
}
