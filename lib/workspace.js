// Workspace root, trust state and path checks.
// With dsh-workspace-trust installed everything is delegated to `ctx.workspaceTrust`;
// without it the plugin runs restricted: every workspace counts as untrusted and
// project paths must stay inside the workspace.
import fs from 'node:fs';
import path from 'node:path';
import { TEXT } from './text.js';
const isWin = process.platform === 'win32';
export const keyOf = (p) => (isWin ? path.resolve(p).toLowerCase() : path.resolve(p));
function isUnder(child, parent) {
    const c = keyOf(child);
    const p = keyOf(parent);
    return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}
async function realOrResolved(p) {
    try {
        return await fs.promises.realpath(p);
    }
    catch {
        return path.resolve(p);
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
async function exists(p) {
    try {
        await fs.promises.stat(p);
        return true;
    }
    catch {
        return false;
    }
}
/** Same rule as dsh-workspace-trust: nearest `.dsh/settings.yml` or `.git`, else cwd. */
export async function builtinFindRoot(cwd) {
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
function syntaxProblem(rel) {
    const P = TEXT.pathProblem;
    if (typeof rel !== 'string' || rel.trim() === '')
        return P.empty;
    if (rel.includes('\0'))
        return P.nul;
    if (rel.startsWith('~'))
        return P.home;
    if (/^[A-Za-z]:/.test(rel) || rel.startsWith('\\') || rel.startsWith('/') || path.isAbsolute(rel)) {
        return P.absolute;
    }
    let depth = 0;
    for (const s of rel.split(/[\\/]+/)) {
        if (s === '..') {
            if (--depth < 0)
                return P.escape;
        }
        else if (s !== '.' && s !== '')
            depth++;
    }
    return undefined;
}
/** Restricted path check: relative, existing, real path inside the workspace. */
export async function builtinCheckTarget(root, rel, opts = {}) {
    const problem = syntaxProblem(rel);
    if (problem !== undefined)
        return { ok: false, code: 'BAD_PATH', message: TEXT.badPath(rel, problem) };
    let st;
    const joined = path.resolve(root, rel);
    try {
        st = await fs.promises.stat(joined);
    }
    catch {
        return { ok: false, code: 'NOT_FOUND', message: TEXT.notFound(rel) };
    }
    const real = await realOrResolved(joined);
    if (!isUnder(real, await realOrResolved(root))) {
        return { ok: false, code: 'UNTRUSTED', message: TEXT.outsideNoTrust(real) };
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
    return { ok: true, inside: true, realPath: real };
}
/**
 * Facade over the optional trust service. `getTrust()` is read on every call so
 * installing or removing dsh-workspace-trust takes effect without a restart.
 */
export function createWorkspace(getTrust) {
    return {
        hasTrust: () => getTrust() !== undefined,
        findRoot: (cwd) => (getTrust()?.findRoot ?? builtinFindRoot)(cwd),
        state: (root) => getTrust()?.state(root) ?? 'untrusted',
        async ensure(agent, root, signal) {
            const trust = getTrust();
            if (trust === undefined)
                return 'untrusted';
            try {
                return await trust.ensure({ agent, root, signal });
            }
            catch {
                return trust.state(root);
            }
        },
        checkTarget: (root, rel, opts) => {
            const trust = getTrust();
            return trust !== undefined ? trust.checkTarget(root, rel, opts) : builtinCheckTarget(root, rel, opts);
        },
        keyOf,
    };
}
