import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Project } from '../shared/types'
import { store } from './store'
import { now, uid } from './util'

function normalizePath(input: string): string {
  let p = input.trim()
  if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1))
  return path.resolve(p)
}

export class ProjectRegistry {
  private projects: Project[]

  constructor() {
    this.projects = store.loadProjects()
  }

  list(): Project[] {
    return [...this.projects]
  }

  get(id: string): Project | undefined {
    return this.projects.find((p) => p.id === id)
  }

  add(name: string, rawPath: string): Project {
    const cleanName = name.trim()
    if (!cleanName) throw new Error('Nome do projeto é obrigatório')
    const dir = normalizePath(rawPath)
    let stat: fs.Stats
    try {
      stat = fs.statSync(dir)
    } catch {
      throw new Error(`Pasta não encontrada: ${dir}`)
    }
    if (!stat.isDirectory()) throw new Error(`Não é uma pasta: ${dir}`)
    if (this.projects.some((p) => p.path === dir)) {
      throw new Error('Essa pasta já está registrada como projeto')
    }
    const project: Project = { id: uid(), name: cleanName, path: dir, createdAt: now() }
    this.projects.push(project)
    store.saveProjects(this.projects)
    return project
  }

  remove(id: string): void {
    this.projects = this.projects.filter((p) => p.id !== id)
    store.saveProjects(this.projects)
  }
}
