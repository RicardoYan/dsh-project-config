// Workspace root, trust state and path checks.
// With dsh-workspace-trust installed everything is delegated to `ctx.workspaceTrust`;
// without it the plugin runs restricted: every workspace counts as untrusted and
// project paths must stay inside the workspace.
import fs from 'node:fs'
import path from 'node:path'
import type { Text } from './locale.js'
import { TEXT } from './text.js'

const isWin = process.platform === 'win32'

export const keyOf = (p: string): string => (isWin ? path.resolve(p).toLowerCase() : path.resolve(p))

function isUnder(child: string, parent: string): boolean {
  const c = keyOf(child)
  const p = keyOf(parent)
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep)
}

async function realOrResolved(p: string): Promise<string> {
  try {
    return await fs.promises.realpath(p)
  } catch {
    return path.resolve(p)
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(p)).isFile()
  } catch {
    return false
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.promises.stat(p)
    return true
  } catch {
    return false
  }
}

/** Same rule as dsh-workspace-trust: nearest `.dsh/settings.yml` or `.git`, else cwd. */
export async function builtinFindRoot(cwd: string): Promise<string> {
  const start = path.resolve(cwd)
  let current = start
  for (;;) {
    if (
      (await isFile(path.join(current, '.dsh', 'settings.yml'))) ||
      (await exists(path.join(current, '.git')))
    ) {
      return realOrResolved(current)
    }
    const parent = path.dirname(current)
    if (parent === current) return realOrResolved(start)
    current = parent
  }
}

/** One row of `TEXT.pathProblem`: the same reason in both languages. */
interface PathProblemText {
  zh: string
  en: string
}

/** The refusal codes a path check can produce. */
export type CheckCode = 'BAD_PATH' | 'NOT_FOUND' | 'DENIED' | 'UNTRUSTED' | 'WRONG_TYPE' | 'TOO_LARGE'

/** A successful check carries the real path; a refusal carries a rendered reason. */
export type CheckResult =
  | { ok: true; inside: boolean; realPath: string }
  | { ok: false; code: CheckCode; message: Text }

/** What a project path is additionally required to satisfy. */
export interface CheckOptions {
  type?: 'file' | 'directory'
  maxBytes?: number
}

function syntaxProblem(rel: unknown): PathProblemText | undefined {
  const P = TEXT.pathProblem
  if (typeof rel !== 'string' || rel.trim() === '') return P.empty
  if (rel.includes('\0')) return P.nul
  if (rel.startsWith('~')) return P.home
  if (/^[A-Za-z]:/.test(rel) || rel.startsWith('\\') || rel.startsWith('/') || path.isAbsolute(rel)) {
    return P.absolute
  }
  let depth = 0
  for (const s of rel.split(/[\\/]+/)) {
    if (s === '..') {
      if (--depth < 0) return P.escape
    } else if (s !== '.' && s !== '') depth++
  }
  return undefined
}

/** Restricted path check: relative, existing, real path inside the workspace. */
export async function builtinCheckTarget(
  root: string,
  rel: string,
  opts: CheckOptions = {},
): Promise<CheckResult> {
  const problem = syntaxProblem(rel)
  if (problem !== undefined) return { ok: false, code: 'BAD_PATH', message: TEXT.badPath(rel, problem) }
  let st: fs.Stats
  const joined = path.resolve(root, rel)
  try {
    st = await fs.promises.stat(joined)
  } catch {
    return { ok: false, code: 'NOT_FOUND', message: TEXT.notFound(rel) }
  }
  const real = await realOrResolved(joined)
  if (!isUnder(real, await realOrResolved(root))) {
    return { ok: false, code: 'UNTRUSTED', message: TEXT.outsideNoTrust(real) }
  }
  if (opts.type === 'file' && !st.isFile()) {
    return { ok: false, code: 'WRONG_TYPE', message: TEXT.wrongType(rel) }
  }
  if (opts.type === 'directory' && !st.isDirectory()) {
    return { ok: false, code: 'WRONG_TYPE', message: TEXT.wrongType(rel) }
  }
  if (opts.maxBytes !== undefined && st.isFile() && st.size > opts.maxBytes) {
    return { ok: false, code: 'TOO_LARGE', message: TEXT.tooLarge(rel) }
  }
  return { ok: true, inside: true, realPath: real }
}

/** The slice of `ctx.workspaceTrust` this facade calls. */
export interface TrustService {
  findRoot(cwd: string): Promise<string>
  state(root: string): string
  ensure(options: {
    agent?: unknown
    root?: string
    signal?: AbortSignal | undefined
  }): Promise<string>
  checkTarget(root: string, rel: string, opts?: CheckOptions): Promise<CheckResult>
}

/** The facade every feature module uses instead of reaching for `ctx` directly. */
export interface WorkspaceFacade {
  hasTrust(): boolean
  findRoot(cwd: string): Promise<string>
  /** `'trusted' | 'untrusted' | 'unknown'`; always `'untrusted'` without the trust plugin. */
  state(root: string): string
  /** Wait for the trust prompt (the trust plugin asks; this never asks on its own). */
  ensure(agent: unknown, root: string, signal?: AbortSignal): Promise<string>
  checkTarget(root: string, rel: string, opts?: CheckOptions): Promise<CheckResult>
  keyOf(p: string): string
}

/**
 * Facade over the optional trust service. `getTrust()` is read on every call so
 * installing or removing dsh-workspace-trust takes effect without a restart.
 */
export function createWorkspace(getTrust: () => TrustService | undefined): WorkspaceFacade {
  return {
    hasTrust: () => getTrust() !== undefined,
    findRoot: (cwd: string) => (getTrust()?.findRoot ?? builtinFindRoot)(cwd),
    state: (root: string) => getTrust()?.state(root) ?? 'untrusted',
    async ensure(agent: unknown, root: string, signal?: AbortSignal): Promise<string> {
      const trust = getTrust()
      if (trust === undefined) return 'untrusted'
      try {
        return await trust.ensure({ agent, root, signal })
      } catch {
        return trust.state(root)
      }
    },
    checkTarget: (root: string, rel: string, opts?: CheckOptions) => {
      const trust = getTrust()
      return trust !== undefined ? trust.checkTarget(root, rel, opts) : builtinCheckTarget(root, rel, opts)
    },
    keyOf,
  }
}
