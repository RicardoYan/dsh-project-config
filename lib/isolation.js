// Keep a `.dsh/settings.yml` workspace from inheriting an outer git root's
// project skills and AGENTS.md. Both patches only change behavior for sessions
// whose workspace root actually holds `.dsh/settings.yml`.
//
// Official interfaces relied on:
// - @deepseek-ai/dsh-skill-filesystem: `FileSystemSkillProvider.prototype.roots(cwd)`
//   returns project roots tagged `project-dsh` / `project-agents` with a `projectRoot`.
// - @deepseek-ai/dsh-agent-instructions: config field `projectRootMarkers`
//   (child names, first match wins while walking up).
// - cordis: global `internal/config` waterfall runs when a fiber resolves its config;
//   `fiber.restart()` re-resolves it.
import fs from 'node:fs';
import path from 'node:path';
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem';
import { apply as instructionsApply } from '@deepseek-ai/dsh-agent-instructions';
import { builtinFindRoot } from './workspace.js';

export const MARKER = '.dsh/settings.yml';
const PATCHED = Symbol.for('dsh-project-config/skill-roots');
const isWin = process.platform === 'win32';
const keyOf = (p) => (isWin ? path.resolve(p).toLowerCase() : path.resolve(p));

async function realOrResolved(p) {
  try { return await fs.promises.realpath(p); } catch { return path.resolve(p); }
}

async function settingsRoot(cwd) {
  const root = await builtinFindRoot(cwd);
  try { if ((await fs.promises.stat(path.join(root, '.dsh', 'settings.yml'))).isFile()) return root; } catch { /* none */ }
  return undefined;
}

/** Rewrite project skill roots to the settings.yml workspace root. Exported for tests. */
export async function rewriteRoots(roots, cwd) {
  if (cwd === undefined) return roots;
  const project = roots.find((r) => r.source === 'project-dsh' || r.source === 'project-agents');
  if (project === undefined) return roots;
  const root = await settingsRoot(cwd);
  if (root === undefined) return roots;
  if (keyOf(await realOrResolved(project.projectRoot)) === keyOf(root)) return roots;
  return roots.map((r) => {
    if (r.source === 'project-dsh') return { ...r, path: path.join(root, '.dsh', 'skills'), projectRoot: root };
    if (r.source === 'project-agents') return { ...r, path: path.join(root, '.agents', 'skills'), projectRoot: root };
    return r;
  });
}

export function patchSkillRoots(log) {
  const proto = FileSystemSkillProvider?.prototype;
  if (typeof proto?.roots !== 'function') {
    log.warn('dsh-skill-filesystem roots() missing; skills isolation disabled');
    return () => {};
  }
  if (proto[PATCHED]) return () => {};
  const original = proto.roots;
  const patched = async function roots(cwd) {
    const result = await original.call(this, cwd);
    try { return await rewriteRoots(result, cwd); } catch (error) {
      log.warn(`skills isolation failed for ${cwd}: ${error?.message ?? error}`);
      return result;
    }
  };
  patched[PATCHED] = true;
  proto.roots = patched;
  proto[PATCHED] = true;
  return () => {
    if (proto.roots === patched) proto.roots = original;
    delete proto[PATCHED];
  };
}

/** Insert the marker into agent-instructions config and restart loaded instances. */
export function installInstructionsMarker(ctx, log) {
  if (typeof instructionsApply !== 'function') {
    log.warn('dsh-agent-instructions apply missing; AGENTS.md isolation disabled');
    return;
  }
  let active = true;
  ctx.on('internal/config', function (config, next) {
    const out = next();
    if (!active || this?.runtime?.callback !== instructionsApply || out === null || typeof out !== 'object') return out;
    const markers = Array.isArray(out.projectRootMarkers) ? out.projectRootMarkers : ['.git'];
    if (markers.includes(MARKER)) return out;
    return { ...out, projectRootMarkers: [MARKER, ...markers] };
  }, { global: true });

  const restartAll = async (reason) => {
    const runtime = ctx.registry.get(instructionsApply);
    const fibers = runtime ? [...runtime.fibers] : [];
    let restarted = 0;
    for (const fiber of fibers) {
      if (fiber.uid === null) continue;
      try { await fiber.restart(); restarted++; } catch (error) {
        log.warn(`agent-instructions restart failed (${reason}): ${error?.message ?? error}`);
      }
    }
    if (restarted) log.info(`agent-instructions restarted (${reason}): ${restarted}`);
  };

  // Presets are usually mounted before this plugin; restart once the tree settles.
  ctx.inject(['loader'], (c) => {
    c.loader.await().then(() => restartAll('install'), () => restartAll('install'));
  });
  ctx.effect(() => () => {
    active = false;
    setTimeout(() => { restartAll('uninstall').catch(() => {}); }, 0);
  }, 'project-config: instructions marker');
}
