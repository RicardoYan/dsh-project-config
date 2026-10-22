// Workspace root and path checks.
//
// Paths in `.dsh/settings.yml` are resolved against the workspace root. A path
// may land outside the workspace (a directory link such as `tools/` is the usual
// reason), so a successful check does not require the target to stay inside the
// root; it only has to exist with the expected type and size.
import fs from 'node:fs';
import path from 'node:path';
import { TEXT } from './text.js';
const isWin = process.platform === 'win32';
export const keyOf = (p) => (isWin ? path.resolve(p).toLowerCase() : path.resolve(p));
async function realOrResolved(p) {
    try {
        return await fs.promises.realpath(p);
    }
    catch {
        return path.resolve(p);
    }
}
async function exists(p) {
    try {
        await fs.promises.stat(p);
        return true;
    }
    catch {
        return false;
    }
}
async function isFile(p) {
    try {
        return (await fs.promises.stat(p)).isFile();
    }
    catch {
        return false;
    }
}
/** The workspace root of `cwd`: nearest `.dsh/settings.yml` or `.git`, else cwd. */
export async function findRoot(cwd) {
    const start = path.resolve(cwd);
    let current = start;
    for (;;) {
        if ((await isFile(path.join(current, '.dsh', 'settings.yml'))) ||
            (await exists(path.join(current, '.git')))) {
            return realOrResolved(current);
        }
        const parent = path.dirname(current);
        if (parent === current)
            return realOrResolved(start);
        current = parent;
    }
}
/** Check a project-relative path: it must exist, with the expected type and size. */
export async function checkTarget(root, rel, opts = {}) {
    const joined = path.resolve(root, rel);
    let st;
    try {
        st = await fs.promises.stat(joined);
    }
    catch {
        return { ok: false, code: 'NOT_FOUND', message: TEXT.notFound(rel) };
    }
    if (opts.type === 'file' && !st.isFile()) {
        return { ok: false, code: 'WRONG_TYPE', message: TEXT.wrongType(rel) };
    }
    if (opts.type === 'directory' && !st.isDirectory()) {
        return { ok: false, code: 'WRONG_TYPE', message: TEXT.wrongType(rel) };
    }
    if (opts.maxBytes !== undefined && st.isFile() && st.size > opts.maxBytes) {
        return { ok: false, code: 'TOO_LARGE', message: TEXT.tooLarge(rel) };
    }
    return { ok: true, realPath: await realOrResolved(joined) };
}
