// Workspace root and path checks.
//
// Paths in `.dsh/settings.yml` are resolved against the workspace root. A path
// may land outside the workspace (a directory link such as `tools/` is the usual
// reason), so a successful check does not require the target to stay inside the
// root; it only has to exist with the expected type and size.
import fs from 'node:fs'
import path from 'node:path'
import type { Text } from './locale.js'
import { TEXT } from './text.js'

const isWin = process.platform === 'win32'

export const keyOf = (p: string): string => (isWin ? path.resolve(p).toLowerCase() : path.resolve(p))

async function realOrResolved(p: string): Promise<string> {
  try {
    return await fs.promises.realpath(p)
  } catch {
    return path.resolve(p)
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

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(p)).isFile()
  } catch {
    return false
  }
}

/** The workspace root of `cwd`: nearest `.dsh/settings.yml` or `.git`, else cwd. */
export async function findRoot(cwd: string): Promise<string> {
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

/** The refusal codes a path check can produce. */
export type CheckCode = 'NOT_FOUND' | 'WRONG_TYPE' | 'TOO_LARGE'

/** A successful check carries the real path; a refusal carries a rendered reason. */
export type CheckResult =
  | { ok: true; realPath: string }
  | { ok: false; code: CheckCode; message: Text }

/** What a project path is additionally required to satisfy. */
export interface CheckOptions {
  type?: 'file' | 'directory'
  maxBytes?: number
}

/** Check a project-relative path: it must exist, with the expected type and size. */
export async function checkTarget(
  root: string,
  rel: string,
  opts: CheckOptions = {},
): Promise<CheckResult> {
  const joined = path.resolve(root, rel)
  let st: fs.Stats
  try {
    st = await fs.promises.stat(joined)
  } catch {
    return { ok: false, code: 'NOT_FOUND', message: TEXT.notFound(rel) }
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
  return { ok: true, realPath: await realOrResolved(joined) }
}
